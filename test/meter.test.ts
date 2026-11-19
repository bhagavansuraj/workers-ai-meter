import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  AiShedError, UnknownModelPriceError, createMeter, estimateAudioSeconds, estimateTokens,
  extractUnits, type MeterDeps, type MeterMeta,
} from "../src";
import { GEMINI_FLASH_LITE, LLAMA_70B, PRICES, WHISPER_TURBO, meter, type Operation } from "../examples/ai";
import { applySchema, clearLedger, collectingLogger, rows, type Event } from "./helpers";

// The meter runs under the workers pool, so every D1 write here is real.

function deps(overrides: Partial<MeterDeps<Operation>> = {}): MeterDeps<Operation> {
  return {
    ai: { run: async () => ({ response: "ok" }) } as unknown as Ai,
    db: env.DB,
    ...overrides,
  };
}

function slowDb(gate: Promise<void>, onSettle: () => void): D1Database {
  // Shaped like the real binding, so the delay comes from the batch itself.
  return {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => { await gate; onSettle(); return []; },
  } as unknown as D1Database;
}

beforeAll(applySchema);
beforeEach(clearLedger);

describe("transparency", () => {
  it("returns the model result unchanged", async () => {
    const sentinel = { response: "the model said this", usage: { prompt_tokens: 5 } };
    const result = await meter.run(
      deps({ ai: { run: async () => sentinel } as unknown as Ai }),
      { operation: "doc.summarize", attempt: 1 }, { messages: [] },
    );
    expect(result).toBe(sentinel);
  });

  it("records a non-negative integer duration_ms", async () => {
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    const [row] = await rows();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row.duration_ms)).toBe(true);
  });
});

describe("unit extraction", () => {
  it("marks text units reported when the response carries usage, and prices them", async () => {
    await meter.run(
      deps({ ai: { run: async () => ({ response: "x", usage: { prompt_tokens: 5_000, completion_tokens: 2_000 } }) } as unknown as Ai }),
      { operation: "doc.summarize", attempt: 1 }, { messages: [] },
    );
    const [row] = await rows();
    expect(row.units_source).toBe("reported");
    expect([row.units_in, row.units_out]).toEqual([5_000, 2_000]);
    // llama-3.3-70b: 5000 × 0.293 + 2000 × 2.253 = 1465 + 4506
    expect(row.cost_micros).toBe(5_971);
  });

  it("accepts the input_tokens/output_tokens spelling too", () => {
    expect(extractUnits(PRICES[LLAMA_70B], {}, { usage: { input_tokens: 10, output_tokens: 3 } }))
      .toEqual({ unitsIn: 10, unitsOut: 3, source: "reported" });
  });

  it("estimates with unitsSource=estimated, and emits no event, when usage is absent", async () => {
    // Documented provider variance, not a failure: quiet by design, but an estimate is never
    // silently indistinguishable from a measurement.
    const events: Event[] = [];
    await meter.run(
      deps({ ai: { run: async () => ({ response: "a response" }) } as unknown as Ai, logger: collectingLogger(events) }),
      { operation: "doc.summarize", attempt: 1 },
      { messages: [{ role: "user", content: "some prompt text" }] },
    );
    const [row] = await rows();
    expect(row.units_source).toBe("estimated");
    expect(row.units_in).toBeGreaterThan(0);
    expect(row.units_out).toBeGreaterThan(0);
    expect(events).toEqual([]);
  });

  it("takes ASR units from the caller-supplied audioSeconds", async () => {
    await meter.run(
      deps({ ai: { run: async () => ({ text: "hello" }) } as unknown as Ai }),
      { operation: "audio.transcribe", attempt: 1, audioSeconds: 120 }, { audio: "AAAA" },
    );
    const [row] = await rows();
    expect(row.units_source).toBe("reported");
    expect(row.units_in).toBe(120);
    expect(row.cost_micros).toBe(1_000); // 2 min × $0.0005/min
  });

  it("estimates ASR seconds from byte length when no duration is known", () => {
    const units = extractUnits(PRICES[WHISPER_TURBO], { audio: "" }, { text: "" }, { audioBytes: 320_000 });
    expect(units).toEqual({ unitsIn: estimateAudioSeconds(320_000), unitsOut: 0, source: "estimated" });
    expect(units.unitsIn).toBe(20);
  });

  it("estimates ~4 characters per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(1);
  });

  it("never returns both an input and an output duration for an audio model", () => {
    // priceCall SUMS the two sides for per-audio-minute models; that's only right while one
    // side is always zero. Pin the invariant rather than trusting the comment that states it.
    const hints: Array<Partial<MeterMeta<Operation>>> = [{ audioSeconds: 42 }, { audioBytes: 96_000 }, {}];
    for (const hint of hints) {
      const units = extractUnits(PRICES[WHISPER_TURBO], { prompt: "x" }, { text: "hi" }, hint);
      expect(units.unitsIn === 0 || units.unitsOut === 0).toBe(true);
    }
  });
});

describe("failure ownership", () => {
  it("returns the model result and emits ONE ai.meter_write_failed warn when the ledger write rejects", async () => {
    const events: Event[] = [];
    const brokenDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => { throw new Error('D1Error: near "x": syntax error'); },
    } as unknown as D1Database;

    const result = await meter.run(
      deps({ db: brokenDb, logger: collectingLogger(events) }),
      { operation: "doc.summarize", attempt: 1 }, {},
    );

    expect(result).toEqual({ response: "ok" }); // the caller is unaffected
    expect(events).toEqual([{ operation: "ai.meter_write_failed", aiOperation: "doc.summarize", errorName: "Error" }]);
    expect(JSON.stringify(events)).not.toContain("D1Error"); // the class name, never the message
  });

  it("writes an outcome=error row and rethrows the ORIGINAL error", async () => {
    const original = new Error("upstream_exploded");
    await expect(
      meter.run(deps({ ai: { run: async () => { throw original; } } as unknown as Ai }), { operation: "doc.extract", attempt: 2 }, {}, LLAMA_70B),
    ).rejects.toBe(original); // identity, not a wrapper: the call site owns it

    const [row] = await rows();
    expect(row.outcome).toBe("error");
    expect(row.attempt).toBe(2);
    expect(row.cost_micros).toBe(0); // a failed call bills nothing, but is counted
  });

  it("refuses an unpriced model BEFORE calling it", async () => {
    let called = false;
    const unpriced = createMeter<"x">({ prices: PRICES, priceVersion: "v", operationModel: { x: "@cf/some/new-model" } });
    await expect(
      unpriced.run({ ai: { run: async () => { called = true; return {}; } } as unknown as Ai, db: env.DB }, { operation: "x", attempt: 1 }, {}),
    ).rejects.toBeInstanceOf(UnknownModelPriceError);
    expect(called).toBe(false); // a missing price must not cost money first and fail second
  });

  it("resolves before the D1 write settles when waitUntil is given", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const scheduled: Promise<unknown>[] = [];
    await meter.run(
      deps({ db: slowDb(gate, () => { settled = true; }), waitUntil: (p) => { scheduled.push(p); } }),
      { operation: "doc.summarize", attempt: 1 }, {},
    );
    expect(scheduled).toHaveLength(1);
    expect(settled).toBe(false); // the response did not wait for the ledger
    release();
    await Promise.all(scheduled);
    expect(settled).toBe(true);
  });

  it("awaits the write inline when there's no waitUntil (queue consumers)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let resolved = false;
    const pending = meter.run(deps({ db: slowDb(gate, () => {}) }), { operation: "doc.summarize", attempt: 1 }, {})
      .then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await pending;
    expect(resolved).toBe(true);
  });
});

describe("the binding's receiver", () => {
  // REGRESSION GUARD. A first implementation called an extracted `const run = ai.run`, which
  // drops the receiver: it passes against every plain-object stub and throws TypeError against
  // the real Workers AI binding. This stub rejects an unbound call the way the real one does.
  it("calls through the binding, not an extracted method reference", async () => {
    const binding = {
      async run(this: unknown) {
        if (this !== binding) throw new TypeError("Illegal invocation");
        return { response: "ok", usage: { prompt_tokens: 3, completion_tokens: 1 } };
      },
    };
    await expect(meter.run(deps({ ai: binding as unknown as Ai }), { operation: "doc.summarize", attempt: 1 }, {}))
      .resolves.toMatchObject({ response: "ok" });
  });

  it("keeps the receiver on the gateway path too", async () => {
    const binding = {
      async run(this: unknown, ...args: unknown[]) {
        if (this !== binding) throw new TypeError("Illegal invocation");
        expect(args[2]).toEqual({ gateway: { id: "my-gateway" } });
        return { response: "ok" };
      },
    };
    await expect(meter.run(deps({ ai: binding as unknown as Ai, gatewayId: "my-gateway" }), { operation: "doc.summarize", attempt: 1 }, {}))
      .resolves.toMatchObject({ response: "ok" });
  });
});

describe("AI Gateway", () => {
  it("passes gateway:{id} only when a gatewayId is set", async () => {
    const calls: unknown[][] = [];
    const ai = { run: async (...args: unknown[]) => { calls.push(args); return { response: "" }; } } as unknown as Ai;
    await meter.run(deps({ ai }), { operation: "doc.summarize", attempt: 1 }, {});
    await meter.run(deps({ ai, gatewayId: "g" }), { operation: "doc.summarize", attempt: 1 }, {});
    expect(calls[0]).toHaveLength(2);
    expect(calls[1][2]).toEqual({ gateway: { id: "g" } });
  });

  it("asks the gateway not to log bodies when collectLog is false", async () => {
    const calls: unknown[][] = [];
    const ai = { run: async (...args: unknown[]) => { calls.push(args); return { response: "" }; } } as unknown as Ai;
    await meter.run(deps({ ai, gatewayId: "g", collectLog: false }), { operation: "doc.summarize", attempt: 1 }, {});
    expect(calls[0][2]).toEqual({ gateway: { id: "g", collectLog: false } });
  });
});

describe("runGateway: the provider path", () => {
  const GEMINI_OK = {
    candidates: [{ content: { parts: [{ text: "{}" }] } }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, totalTokenCount: 1500 },
  };
  function gatewayAi(json: unknown): Ai {
    return {
      gateway: () => ({
        run: async () => {
          if (json instanceof Error) throw json;
          return { json: async () => json };
        },
      }),
    } as unknown as Ai;
  }
  const request = { provider: "google-ai-studio", endpoint: "v1beta/models/gemini-2.5-flash-lite:generateContent", query: {} };

  it("maps Google's usageMetadata to reported units and prices them", async () => {
    await meter.runGateway(deps({ ai: gatewayAi(GEMINI_OK) }), { operation: "doc.extract", attempt: 1 }, GEMINI_FLASH_LITE, "g", request);
    const [row] = await rows();
    expect(row).toMatchObject({
      model: GEMINI_FLASH_LITE, provider: "google-ai-studio", units_in: 1200, units_out: 300,
      units_source: "reported", cost_micros: 240, outcome: "ok", // 1200 × 0.1 + 300 × 0.4
    });
  });

  it("records an error row and rethrows", async () => {
    await expect(
      meter.runGateway(deps({ ai: gatewayAi(new Error("gateway_down")) }), { operation: "doc.extract", attempt: 1 }, GEMINI_FLASH_LITE, "g", request),
    ).rejects.toThrow("gateway_down");
    expect((await rows())[0].outcome).toBe("error");
  });
});

describe("fallback attribution", () => {
  it("prices a fallback row against the model that actually ran", async () => {
    await meter.run(
      deps({ ai: { run: async () => ({ response: "ok", usage: { prompt_tokens: 1000, completion_tokens: 100 } }) } as unknown as Ai }),
      { operation: "doc.extract", attempt: 1 }, {}, LLAMA_70B,
    );
    const [row] = await rows();
    expect(row.model).toBe(LLAMA_70B);
    expect(row.provider).toBe("workers-ai");
  });
});

describe("shed operations", () => {
  it("never reach the model, and are recorded at zero cost", async () => {
    let called = false;
    await expect(
      meter.run(
        deps({ ai: { run: async () => { called = true; return {}; } } as unknown as Ai, shed: new Set<Operation>(["doc.tags"]) }),
        { operation: "doc.tags", attempt: 1 }, {},
      ),
    ).rejects.toBeInstanceOf(AiShedError);
    expect(called).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ outcome: "empty", cost_micros: 0 });
  });
});
