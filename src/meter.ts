// The ONE seam every model call goes through.
//
// Pair it with the `no-unmetered-ai-run` ESLint rule (eslint/), which makes this the only file
// in your app allowed to call `AI.run`. An unmetered call site is a silent hole in the bill, so
// the constraint is structural, not a convention.
//
// Failure ownership. Each failure has exactly one owner:
//   - the ledger write fails       -> recovered, background: one warn; the model result is still returned
//   - the model call throws        -> propagated: an outcome:"error" row is written, then the ORIGINAL
//                                     error is rethrown, so the call site stays the single terminal owner
//   - the response carries no usage -> expected/quiet: unitsSource:"estimated", no event

import { priceCall, type PriceTable } from "./pricing";
import { recordUsage } from "./ledger";
import { extractUnits, type AudioHints } from "./units";

/** Matches the shape of a structured logger; only `warn` is used. Never receives raw errors. */
export type MeterLogger = {
  warn(event: { operation: string; aiOperation?: string; errorName?: string }): void;
};

export type MeterConfig<Op extends string> = {
  prices: PriceTable;
  /** The model each operation runs on today. A closed map, so a new operation must pick one. */
  operationModel: Readonly<Record<Op, string>>;
  /** Stamped on every row. Bump it whenever a price changes; see computePriceChecksum. */
  priceVersion: string;
};

export type MeterDeps<Op extends string> = {
  ai: Ai;
  db: D1Database;
  /**
   * ExecutionContext.waitUntil, so the ledger write never sits on the response path. OMIT it in
   * queue consumers and other non-request contexts: there the write is awaited inline, where a
   * few milliseconds against a background job cost nothing and a floating promise might never
   * settle.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  logger?: MeterLogger;
  /** When set, calls are routed through the AI Gateway, which gives you a second ledger to reconcile against. */
  gatewayId?: string;
  /**
   * false asks the AI Gateway not to log this call's request/response bodies. Gateway logs
   * retain bodies, so turn this off for any operation whose prompt carries user content you
   * don't want retained outside your own data boundary.
   */
  collectLog?: false;
  nowMs?: () => number;
  nowS?: () => number;
  /**
   * Operations currently shed by the hard spend cap (see spendCap.ts). A shed call never
   * reaches the model: it records a zero-cost `empty` row and throws AiShedError.
   */
  shed?: ReadonlySet<Op>;
};

export type MeterMeta<Op extends string> = AudioHints & {
  operation: Op;
  /** Opaque id to attribute cost to (tenant, workspace, document). Omit on anonymous paths. */
  subjectId?: string | null;
  /** 1-based. Retries are SEPARATE rows and are never merged. Retries are the cost driver. */
  attempt: number;
};

/** Thrown instead of calling the model when the hard spend cap has shed the operation. */
export class AiShedError extends Error {
  constructor(readonly operation: string) {
    super(`ai operation ${operation} shed by the spend cap`);
    this.name = "AiShedError";
  }
}

const SAFE_ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** An error's class name if it's a safe token, else undefined. Never the message or the stack. */
export function safeErrorName(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    return SAFE_ERROR_NAME_RE.test(error.name) ? error.name : undefined;
  } catch {
    // expected-failure: hostile error objects must not break logging
    return undefined;
  }
}

type WritePart = {
  outcome: "ok" | "error" | "empty";
  durationMs: number;
  createdAt: number;
  unitsIn: number;
  unitsOut: number;
  unitsSource: "reported" | "estimated";
  costMicros: number;
};

export function createMeter<Op extends string>(config: MeterConfig<Op>) {
  const { prices, operationModel, priceVersion } = config;

  function write(deps: MeterDeps<Op>, meta: MeterMeta<Op>, model: string, part: WritePart): Promise<void> {
    return recordUsage(deps.db, {
      createdAt: part.createdAt,
      operation: meta.operation,
      model,
      provider: prices[model]?.provider ?? "unknown",
      subjectId: meta.subjectId ?? null,
      attempt: meta.attempt,
      outcome: part.outcome,
      durationMs: Math.max(0, part.durationMs),
      unitsIn: part.unitsIn,
      unitsOut: part.unitsOut,
      unitsSource: part.unitsSource,
      costMicros: part.costMicros,
      priceVersion,
    }).catch((error: unknown) => {
      // Recovered/background: metering must never become a new failure mode for a
      // user-facing request. Exactly one event, no raw diagnostics.
      deps.logger?.warn({
        operation: "ai.meter_write_failed",
        aiOperation: meta.operation,
        errorName: safeErrorName(error),
      });
    });
  }

  async function schedule(deps: MeterDeps<Op>, meta: MeterMeta<Op>, model: string, part: WritePart): Promise<void> {
    const promise = write(deps, meta, model, part);
    if (deps.waitUntil) deps.waitUntil(promise);
    else await promise;
  }

  /** Shared body: shed check → call → row → result. `call` is the only transport-specific part. */
  async function metered<T>(
    deps: MeterDeps<Op>, meta: MeterMeta<Op>, model: string, inputs: unknown, call: () => Promise<unknown>,
  ): Promise<T> {
    // Price lookup up front: an unpriced model must fail before it spends, not after.
    if (!prices[model]) priceCall(prices, model, 0, 0);
    const nowMs = deps.nowMs ?? (() => Date.now());
    const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
    const startedAt = nowMs();

    if (deps.shed?.has(meta.operation)) {
      // Recorded, not silently skipped: a shed call is a fact about the month that the
      // ledger should show, at zero cost.
      await schedule(deps, meta, model, {
        outcome: "empty", durationMs: 0, createdAt: nowS(),
        unitsIn: 0, unitsOut: 0, unitsSource: "reported", costMicros: 0,
      });
      throw new AiShedError(meta.operation);
    }

    let result: unknown;
    try {
      result = await call();
    } catch (error) {
      // The failed attempt gets a row too: call counts catch a tight retry loop even when
      // the tokens are free.
      await schedule(deps, meta, model, {
        outcome: "error", durationMs: nowMs() - startedAt, createdAt: nowS(),
        unitsIn: 0, unitsOut: 0, unitsSource: "estimated", costMicros: 0,
      });
      throw error; // identity, not a wrapper: the call site remains the single terminal owner
    }

    const units = extractUnits(prices[model], inputs, result, meta);
    await schedule(deps, meta, model, {
      outcome: "ok", durationMs: nowMs() - startedAt, createdAt: nowS(),
      unitsIn: units.unitsIn, unitsOut: units.unitsOut, unitsSource: units.source,
      costMicros: priceCall(prices, model, units.unitsIn, units.unitsOut),
    });
    return result as T;
  }

  return {
    /**
     * Runs one Workers AI call, records exactly one usage row for it, and returns the model's
     * result unchanged. Transparent by contract: a caller can't tell it's being metered except
     * by reading the ledger.
     *
     * `modelOverride` exists for one case: a declared FALLBACK running a different model from
     * the one `operationModel` names. The row must record the model that actually served the
     * call. Pricing a fallback against the intended model would misprice it.
     */
    run<T = unknown>(deps: MeterDeps<Op>, meta: MeterMeta<Op>, inputs: unknown, modelOverride?: string): Promise<T> {
      const model = modelOverride ?? operationModel[meta.operation];
      const options = deps.gatewayId
        ? { gateway: deps.collectLog === false ? { id: deps.gatewayId, collectLog: false } : { id: deps.gatewayId } }
        : undefined;
      // Call THROUGH the binding, never through an extracted `const run = ai.run`. The real
      // Workers AI binding needs its receiver: an unbound call throws TypeError in production
      // while passing happily against every plain-object stub. (A mixed-mode smoke test caught
      // this; the unit tests didn't. There's now a regression test.)
      const ai = deps.ai as unknown as { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
      return metered<T>(deps, meta, model, inputs, () =>
        options ? ai.run(model, inputs, options) : ai.run(model, inputs),
      );
    },

    /**
     * One metered call to a third-party model reached through the AI Gateway's PROVIDER path,
     * e.g. Gemini via `google-ai-studio`.
     *
     * A separate entry point, not a flag on run(), because the two are different calls:
     * `env.AI.run()` rejects a provider-prefixed model id outright (AiGatewayError 7003), and
     * `env.AI.gateway(id).run({ provider, endpoint, query })` returns the provider's own native
     * response shape. What is NOT different: the same single ledger row and the same
     * failure ownership.
     */
    runGateway(
      deps: MeterDeps<Op>, meta: MeterMeta<Op>, model: string, gatewayId: string,
      request: { provider: string; endpoint: string; query: unknown },
    ): Promise<unknown> {
      const ai = deps.ai as unknown as {
        gateway(id: string): { run(input: unknown): Promise<{ json(): Promise<unknown> }> };
      };
      return metered(deps, meta, model, request.query, async () => {
        const response = await ai.gateway(gatewayId).run({
          provider: request.provider,
          endpoint: request.endpoint,
          headers: { "Content-Type": "application/json" },
          query: request.query,
        });
        return response.json();
      });
    },
  };
}

export type Meter<Op extends string> = ReturnType<typeof createMeter<Op>>;
