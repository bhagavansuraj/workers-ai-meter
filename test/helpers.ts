import { env } from "cloudflare:test";
import schema from "../migrations/0001_ai_usage.sql?raw";
import type { MeterLogger } from "../src";

declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database }
}

export async function applySchema(): Promise<void> {
  const statements = schema
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^CREATE (TABLE|INDEX) /, "CREATE $1 IF NOT EXISTS "));
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

export async function clearLedger(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ai_usage`),
    env.DB.prepare(`DELETE FROM ai_usage_daily`),
    env.DB.prepare(`DELETE FROM ai_spend`),
  ]);
}

export type Event = { operation: string; [key: string]: unknown };
export function collectingLogger(sink: Event[]): MeterLogger & { error(e: Event): void } {
  const push = (event: Event) => { sink.push(event); };
  return { warn: push, error: push };
}

export type Row = {
  created_at: number; operation: string; model: string; provider: string; subject_id: string | null;
  attempt: number; outcome: string; duration_ms: number; units_in: number; units_out: number;
  units_source: string; cost_micros: number; price_version: string;
};
export async function rows(): Promise<Row[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM ai_usage ORDER BY rowid`).all<Row>();
  return results ?? [];
}
