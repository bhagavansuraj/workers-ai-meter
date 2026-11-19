// Every SQL statement that touches ai_usage / ai_usage_daily / ai_spend lives here.
//
// Three tables, three jobs:
//   ai_usage        one row per ATTEMPT (retries are never merged), pruned after 90 days
//   ai_usage_daily  the permanent roll-up, keyed (day, operation, model), never pruned
//   ai_spend        the month-to-date counter the spend cap reads, plus a once-a-month latch
//
// Raw D1 rather than an ORM, so the roll-up is one INSERT … ON CONFLICT DO UPDATE fold and
// all three writes go in a single batch.

export const USAGE_RETENTION_DAYS = 90;

export type UsageOutcome = "ok" | "error" | "empty";
export type UnitsSource = "reported" | "estimated";

export type UsageRow = {
  createdAt: number; // unix seconds
  operation: string;
  model: string;
  provider: string;
  /**
   * An OPAQUE id for whatever you want unit cost per (a tenant, a workspace, a document).
   * Never a user id or an email: see readPerSubjectCost for why.
   */
  subjectId: string | null;
  attempt: number;
  outcome: UsageOutcome;
  durationMs: number;
  unitsIn: number;
  unitsOut: number;
  unitsSource: UnitsSource;
  costMicros: number;
  priceVersion: string;
};

/** UTC midnight for a unix-seconds timestamp. */
export function dayStartFor(nowS: number): number {
  const d = new Date(nowS * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

/** UTC month start for a unix-seconds timestamp. */
export function monthStartFor(nowS: number): number {
  const d = new Date(nowS * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/**
 * Append one attempt and fold it into the day's roll-up and the month's spend counter, in a
 * single batch, so a partial write can't leave the roll-up disagreeing with the rows it
 * summarises.
 */
export async function recordUsage(db: D1Database, row: UsageRow): Promise<void> {
  const day = dayStartFor(row.createdAt);
  const month = monthStartFor(row.createdAt);
  await db.batch([
    db
      .prepare(
        `INSERT INTO ai_usage
           (created_at, operation, model, provider, subject_id, attempt, outcome,
            duration_ms, units_in, units_out, units_source, cost_micros, price_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        row.createdAt, row.operation, row.model, row.provider, row.subjectId,
        row.attempt, row.outcome, row.durationMs, row.unitsIn, row.unitsOut,
        row.unitsSource, row.costMicros, row.priceVersion,
      ),
    db
      .prepare(
        `INSERT INTO ai_usage_daily (day, operation, model, calls, errors, units_in, units_out, cost_micros)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)
         ON CONFLICT(day, operation, model) DO UPDATE SET
           calls = ai_usage_daily.calls + 1,
           errors = ai_usage_daily.errors + excluded.errors,
           units_in = ai_usage_daily.units_in + excluded.units_in,
           units_out = ai_usage_daily.units_out + excluded.units_out,
           cost_micros = ai_usage_daily.cost_micros + excluded.cost_micros`,
      )
      .bind(day, row.operation, row.model, row.outcome === "error" ? 1 : 0,
            row.unitsIn, row.unitsOut, row.costMicros),
    db
      .prepare(
        `INSERT INTO ai_spend (month_start, cost_micros) VALUES (?1, ?2)
         ON CONFLICT(month_start) DO UPDATE SET cost_micros = ai_spend.cost_micros + excluded.cost_micros`,
      )
      .bind(month, row.costMicros),
  ]);
}

export type DailyRow = {
  day: number;
  operation: string;
  model: string;
  calls: number;
  errors: number;
  units_in: number;
  units_out: number;
  cost_micros: number;
};

/** Roll-up rows since a day. This is what dashboards and projections read: never per-call rows. */
export async function readDaily(db: D1Database, sinceDay: number, limit = 400): Promise<DailyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT day, operation, model, calls, errors, units_in, units_out, cost_micros
         FROM ai_usage_daily WHERE day >= ?1 ORDER BY day DESC, operation ASC LIMIT ?2`,
    )
    .bind(sinceDay, limit)
    .all<DailyRow>();
  return results ?? [];
}

export type PerSubjectCost = {
  /** Distinct subjects with at least one attributed call in the window. */
  subjects: number;
  totalMicros: number;
  meanMicros: number;
  p50Micros: number;
  p90Micros: number;
  maxMicros: number;
};

/**
 * Unit cost per subject: the number per-operation averages can't recover, because it's a
 * distribution and averages hide the tail.
 *
 * Returns a distribution and NEVER an identifier. Costs are grouped by subject_id inside D1
 * and only the aggregate leaves this function, so an ops surface can answer "what does a
 * customer cost us" without carrying who they are. Rows with no subject are excluded rather
 * than bucketed into a fake one.
 */
export async function readPerSubjectCost(db: D1Database, sinceS: number): Promise<PerSubjectCost> {
  const { results } = await db
    .prepare(
      `SELECT SUM(cost_micros) AS total
         FROM ai_usage
        WHERE subject_id IS NOT NULL AND created_at >= ?1
        GROUP BY subject_id
        ORDER BY total ASC`,
    )
    .bind(sinceS)
    .all<{ total: number }>();

  const totals = (results ?? []).map((row) => row.total ?? 0);
  if (totals.length === 0) {
    return { subjects: 0, totalMicros: 0, meanMicros: 0, p50Micros: 0, p90Micros: 0, maxMicros: 0 };
  }
  const sum = totals.reduce((acc, value) => acc + value, 0);
  // Nearest-rank percentiles on an ascending list: no interpolation, so every reported
  // figure is a cost some real subject actually incurred.
  const at = (fraction: number) =>
    totals[Math.min(totals.length - 1, Math.max(0, Math.ceil(fraction * totals.length) - 1))];
  return {
    subjects: totals.length,
    totalMicros: sum,
    meanMicros: Math.round(sum / totals.length),
    p50Micros: at(0.5),
    p90Micros: at(0.9),
    maxMicros: totals[totals.length - 1],
  };
}

export async function readSpend(
  db: D1Database, monthStart: number,
): Promise<{ costMicros: number; softNotifiedAt: number | null } | null> {
  const row = await db
    .prepare(`SELECT cost_micros, soft_notified_at FROM ai_spend WHERE month_start = ?1`)
    .bind(monthStart)
    .first<{ cost_micros: number; soft_notified_at: number | null }>();
  return row ? { costMicros: row.cost_micros, softNotifiedAt: row.soft_notified_at } : null;
}

/**
 * Conditional-UPDATE latch: returns true for exactly one caller per month, however many
 * isolates race to it. That makes "alert once" correct without a lock.
 */
export async function latchSoftCapNotice(db: D1Database, monthStart: number, nowS: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE ai_spend SET soft_notified_at = ?2 WHERE month_start = ?1 AND soft_notified_at IS NULL`)
    .bind(monthStart, nowS)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Prunes ai_usage only. ai_usage_daily is the permanent record and is never pruned. */
export async function pruneUsage(db: D1Database, nowS: number, retentionDays = USAGE_RETENTION_DAYS): Promise<number> {
  const cutoff = nowS - retentionDays * 86_400;
  const result = await db.prepare(`DELETE FROM ai_usage WHERE created_at < ?1`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
