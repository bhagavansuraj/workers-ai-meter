// A spend guardrail for product-path AI calls.
//
// The naive cap ("over budget → turn AI off") is wrong when the AI IS the product: shedding
// your core call doesn't save money, it breaks the product for the user in front of you. So:
//
//   soft cap  → ALERT once a month. Nothing is disabled.
//   hard cap  → shed capability in ONE stated order, the least load-bearing operation first.
//               Each further step past the hard cap sheds the next operation.
//               Core operations are simply never in the order.
//
// The meter enforces it: pass `shed` from readSpendState into MeterDeps, and a shed call
// records a zero-cost `empty` row and throws AiShedError without reaching the model.

import { latchSoftCapNotice, monthStartFor, readSpend } from "./ledger";
import { safeErrorName } from "./meter";

export type SpendPolicy<Op extends string> = {
  /** Alert threshold, USD micros per month. */
  softCapMicros: number;
  /** Degradation begins here. */
  hardCapMicros: number;
  /** Each further step past the hard cap sheds the next operation in order. */
  stepMicros: number;
  /** Least load-bearing first. Operations NOT listed are never shed. */
  degradationOrder: readonly Op[];
};

export type SpendLogger = {
  warn(event: { operation: string; errorName?: string }): void;
  error(event: { operation: string; costMicros?: number }): void;
};

/** Which operations are shed at a given month-to-date spend. */
export function shedOperations<Op extends string>(policy: SpendPolicy<Op>, costMicros: number): ReadonlySet<Op> {
  const shed = new Set<Op>();
  if (costMicros < policy.hardCapMicros) return shed;
  const steps = Math.floor((costMicros - policy.hardCapMicros) / policy.stepMicros) + 1;
  for (const operation of policy.degradationOrder.slice(0, steps)) shed.add(operation);
  return shed;
}

export type SpendState<Op extends string> = {
  costMicros: number;
  softCapped: boolean;
  shed: ReadonlySet<Op>;
};

/**
 * Reads the month's spend. On the FIRST crossing of the soft cap in a month, it emits one event
 * and calls `onSoftCap` once, using a conditional-UPDATE latch, so concurrent isolates can't
 * double-alert.
 *
 * Never throws: a guardrail that can fail a request is worse than no guardrail.
 */
export async function readSpendState<Op extends string>(
  db: D1Database,
  policy: SpendPolicy<Op>,
  nowS: number,
  opts: { logger?: SpendLogger; onSoftCap?: (costMicros: number) => Promise<void> } = {},
): Promise<SpendState<Op>> {
  const month = monthStartFor(nowS);
  let costMicros = 0;
  try {
    costMicros = (await readSpend(db, month))?.costMicros ?? 0;
  } catch (error) {
    // Recovered, and NEVER silent. Failing open is right: an unreadable counter must not fail
    // a user's request. But failing open with no event would quietly disable both the alert
    // and the degradation for as long as the database is unhappy: an infrastructure failure
    // disguised as an empty success. So: one event, then fail open.
    opts.logger?.warn({ operation: "ai.spend_read_failed", errorName: safeErrorName(error) });
    return { costMicros: 0, softCapped: false, shed: new Set() };
  }

  const softCapped = costMicros >= policy.softCapMicros;
  if (softCapped) {
    try {
      if (await latchSoftCapNotice(db, month, nowS)) {
        opts.logger?.error({ operation: "ai.spend_capped", costMicros });
        await opts.onSoftCap?.(costMicros);
      }
    } catch {
      // expected-failure: the notice is best-effort; the cap state below still stands
    }
  }
  return { costMicros, softCapped, shed: shedOperations(policy, costMicros) };
}
