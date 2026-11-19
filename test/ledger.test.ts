import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  USAGE_RETENTION_DAYS, dayStartFor, monthStartFor, priceCall, pruneUsage, readDaily,
  readPerSubjectCost, readSpend, recordUsage, type MeterDeps,
} from "../src";
import { LLAMA_70B, PRICES, PRICE_VERSION, meter, type Operation } from "../examples/ai";
import { applySchema, clearLedger, rows } from "./helpers";

const NOW = 1_787_000_000; // mid-month, so day start ≠ month start

function deps(overrides: Partial<MeterDeps<Operation>> = {}): MeterDeps<Operation> {
  return {
    ai: { run: async () => ({ response: "ok", usage: { prompt_tokens: 100, completion_tokens: 10 } }) } as unknown as Ai,
    db: env.DB,
    nowS: () => NOW,
    ...overrides,
  };
}

beforeAll(applySchema);
beforeEach(clearLedger);

describe("ai_usage: one row per attempt", () => {
  it("writes a separate row for each retry", async () => {
    // Retries are the cost driver the ledger exists to expose. Merging them would report a
    // fraction of the real spend.
    const failing = deps({ ai: { run: async () => { throw new Error("inference_failed"); } } as unknown as Ai });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await meter.run(failing, { operation: "doc.summarize", subjectId: "ws-retry", attempt }, {}).catch(() => undefined);
    }
    const all = await rows();
    expect(all.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(all.every((row) => row.outcome === "error" && row.subject_id === "ws-retry")).toBe(true);
  });

  it("stamps price_version and provider on every row", async () => {
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    const [row] = await rows();
    expect(row.price_version).toBe(PRICE_VERSION);
    expect(row.provider).toBe("workers-ai");
  });
});

describe("ai_usage_daily: the fold", () => {
  it("collapses same day/operation/model rows into one, summing calls, units and cost", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) await meter.run(deps(), { operation: "doc.summarize", attempt }, {});
    const daily = await readDaily(env.DB, dayStartFor(NOW) - 86_400);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ calls: 3, errors: 0, units_in: 300, units_out: 30 });
    expect(daily[0].cost_micros).toBe(3 * priceCall(PRICES, LLAMA_70B, 100, 10));
  });

  it("keys days at UTC midnight, so two calendar days make two rows", async () => {
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    await meter.run(deps({ nowS: () => NOW + 86_400 }), { operation: "doc.summarize", attempt: 1 }, {});
    const daily = await readDaily(env.DB, dayStartFor(NOW) - 86_400);
    expect(daily.map((row) => row.day % 86_400)).toEqual([0, 0]);
  });

  it("counts a failed call in calls and errors, at zero cost", async () => {
    await meter.run(deps({ ai: { run: async () => { throw new Error("boom"); } } as unknown as Ai }), { operation: "doc.summarize", attempt: 1 }, {})
      .catch(() => undefined);
    const [row] = await readDaily(env.DB, dayStartFor(NOW) - 86_400);
    expect(row).toMatchObject({ calls: 1, errors: 1, cost_micros: 0 });
  });

  it("keeps the month's spend counter in step with the daily fold", async () => {
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    const spend = await readSpend(env.DB, monthStartFor(NOW));
    const daily = await readDaily(env.DB, dayStartFor(NOW) - 86_400);
    expect(spend?.costMicros).toBe(daily[0].cost_micros);
  });
});

describe("retention", () => {
  it("prunes ai_usage past the window and leaves ai_usage_daily untouched", async () => {
    const old = NOW - (USAGE_RETENTION_DAYS + 1) * 86_400;
    await meter.run(deps({ nowS: () => old }), { operation: "doc.summarize", attempt: 1 }, {});
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    expect(await pruneUsage(env.DB, NOW)).toBe(1);
    expect((await rows()).map((row) => row.created_at)).toEqual([NOW]);
    expect(await readDaily(env.DB, dayStartFor(old) - 86_400)).toHaveLength(2);
  });
});

describe("privacy boundary", () => {
  it("has no user-identity columns", async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(ai_usage)`).all<{ name: string }>();
    const columns = (results ?? []).map((column) => column.name);
    expect(columns).toContain("subject_id");
    for (const banned of ["user_id", "email", "prompt", "completion"]) expect(columns).not.toContain(banned);
  });

  it("writes no substring of the prompt, the completion, or a secret into any column", async () => {
    const SECRET = "sk-live-51H8ZfakeSECRETvalue";
    const DOC = `Jane Doe, jane@example.com. API key ${SECRET}. Led payments at Acme.`;
    await meter.run(
      deps({ ai: { run: async () => ({ response: `structured ${DOC}` }) } as unknown as Ai }),
      { operation: "doc.summarize", subjectId: "ws-hostile", attempt: 1 },
      { messages: [{ role: "user", content: DOC }] },
    );
    const serialized = JSON.stringify(await rows());
    for (const fragment of [SECRET, "jane@example.com", "Jane Doe", "Acme", "payments"]) {
      expect(serialized, `leaked: ${fragment}`).not.toContain(fragment);
    }
  });
});

describe("per-subject unit cost", () => {
  async function seed(subjectId: string | null, costMicros: number, at = NOW): Promise<void> {
    await recordUsage(env.DB, {
      createdAt: at, operation: "doc.summarize", model: LLAMA_70B, provider: "workers-ai",
      subjectId, attempt: 1, outcome: "ok", durationMs: 5, unitsIn: 0, unitsOut: 0,
      unitsSource: "reported", costMicros, priceVersion: PRICE_VERSION,
    });
  }

  it("returns a distribution grouped by subject, and never an identifier", async () => {
    await seed("ws-a", 10);
    await seed("ws-b", 12);
    await seed("ws-b", 8);
    await seed("ws-c", 30);
    await seed("ws-d", 100);
    await seed(null, 5_000); // unattributed: excluded, not bucketed

    const stats = await readPerSubjectCost(env.DB, NOW - 86_400);
    expect(stats).toEqual({ subjects: 4, totalMicros: 160, meanMicros: 40, p50Micros: 20, p90Micros: 100, maxMicros: 100 });
    expect(JSON.stringify(stats)).not.toContain("ws-");
  });

  it("returns zeroes rather than dividing by zero on an empty window", async () => {
    await seed("ws-old", 500, NOW - 400 * 86_400);
    expect(await readPerSubjectCost(env.DB, NOW - 86_400)).toEqual({
      subjects: 0, totalMicros: 0, meanMicros: 0, p50Micros: 0, p90Micros: 0, maxMicros: 0,
    });
  });
});

describe("history is never retroactively repriced", () => {
  it("keeps the original cost_micros and price_version on an existing row", async () => {
    await recordUsage(env.DB, {
      createdAt: NOW - 86_400, operation: "doc.summarize", model: LLAMA_70B, provider: "workers-ai",
      subjectId: null, attempt: 1, outcome: "ok", durationMs: 10, unitsIn: 1_000, unitsOut: 100,
      unitsSource: "reported", costMicros: 999_999, priceVersion: "2020-01-01",
    });
    await meter.run(deps(), { operation: "doc.summarize", attempt: 1 }, {});
    const all = await rows();
    expect(all.find((row) => row.price_version === "2020-01-01")?.cost_micros).toBe(999_999);
    expect(all.some((row) => row.price_version === PRICE_VERSION)).toBe(true);
  });
});
