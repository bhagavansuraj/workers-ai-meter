import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { AiShedError, monthStartFor, readSpendState, shedOperations } from "../src";
import { SPEND_POLICY, meter } from "../examples/ai";
import { applySchema, clearLedger, collectingLogger, type Event } from "./helpers";

const NOW = 1_787_000_000;
const MONTH = monthStartFor(NOW);
const { softCapMicros: SOFT, hardCapMicros: HARD, stepMicros: STEP } = SPEND_POLICY;

async function seedSpend(costMicros: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_spend (month_start, cost_micros) VALUES (?1, ?2)
     ON CONFLICT(month_start) DO UPDATE SET cost_micros = ?2, soft_notified_at = NULL`,
  ).bind(MONTH, costMicros).run();
}

beforeAll(applySchema);
beforeEach(clearLedger);

describe("soft cap", () => {
  it("does nothing under the cap", async () => {
    await seedSpend(SOFT - 1);
    const events: Event[] = [];
    const alerts: number[] = [];
    const state = await readSpendState(env.DB, SPEND_POLICY, NOW, {
      logger: collectingLogger(events), onSoftCap: async (micros) => { alerts.push(micros); },
    });
    expect(state).toMatchObject({ softCapped: false });
    expect(state.shed.size).toBe(0);
    expect(events).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("alerts once when tripped, and sheds nothing", async () => {
    await seedSpend(SOFT);
    const events: Event[] = [];
    const alerts: number[] = [];
    const state = await readSpendState(env.DB, SPEND_POLICY, NOW, {
      logger: collectingLogger(events), onSoftCap: async (micros) => { alerts.push(micros); },
    });
    expect(state.softCapped).toBe(true);
    expect(state.shed.size).toBe(0); // the product keeps working
    expect(events).toEqual([{ operation: "ai.spend_capped", costMicros: SOFT }]);
    expect(alerts).toEqual([SOFT]);
  });

  it("sends no second alert for later trips in the same month", async () => {
    await seedSpend(SOFT + 1);
    const alerts: number[] = [];
    const onSoftCap = async (micros: number) => { alerts.push(micros); };
    await readSpendState(env.DB, SPEND_POLICY, NOW, { onSoftCap });
    await readSpendState(env.DB, SPEND_POLICY, NOW + 60, { onSoftCap });
    await readSpendState(env.DB, SPEND_POLICY, NOW + 120, { onSoftCap });
    expect(alerts).toHaveLength(1);
  });

  it("starts each month clean", async () => {
    await seedSpend(HARD * 10);
    const state = await readSpendState(env.DB, SPEND_POLICY, NOW + 40 * 86_400);
    expect(state.costMicros).toBe(0);
    expect(state.shed.size).toBe(0);
  });

  it("fails open on an unreadable counter, but never silently", async () => {
    const brokenDb = { prepare: () => { throw new Error("D1Error: disk I/O"); } } as unknown as D1Database;
    const events: Event[] = [];
    const alerts: number[] = [];
    const state = await readSpendState(brokenDb, SPEND_POLICY, NOW, {
      logger: collectingLogger(events), onSoftCap: async (micros) => { alerts.push(micros); },
    });
    expect(state).toEqual({ costMicros: 0, softCapped: false, shed: new Set() });
    expect(events).toEqual([{ operation: "ai.spend_read_failed", errorName: "Error" }]);
    expect(JSON.stringify(events)).not.toContain("disk I/O");
    expect(alerts).toEqual([]); // a read failure is not a spend alert
  });
});

describe("hard cap: the stated degradation order", () => {
  it("sheds one more operation per step past the hard cap", () => {
    expect([...shedOperations(SPEND_POLICY, HARD - 1)]).toEqual([]);
    expect([...shedOperations(SPEND_POLICY, HARD)]).toEqual(["doc.tags"]);
    expect([...shedOperations(SPEND_POLICY, HARD + STEP)]).toEqual(["doc.tags", "doc.ocr_page"]);
    expect([...shedOperations(SPEND_POLICY, HARD + 2 * STEP)]).toEqual(["doc.tags", "doc.ocr_page", "doc.summarize"]);
  });

  it("never sheds the core operation at any spend level", () => {
    for (const spend of [HARD, HARD * 10, Number.MAX_SAFE_INTEGER]) {
      expect(shedOperations(SPEND_POLICY, spend).has("doc.extract")).toBe(false);
    }
  });

  it("lets the core call through the meter at a spend level that sheds everything else", async () => {
    const shed = shedOperations(SPEND_POLICY, HARD * 10);
    let called = false;
    await meter.run(
      { ai: { run: async () => { called = true; return { response: "ok" }; } } as unknown as Ai, db: env.DB, shed },
      { operation: "doc.extract", attempt: 1 }, {}, "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    expect(called).toBe(true);
    await expect(
      meter.run({ ai: { run: async () => ({}) } as unknown as Ai, db: env.DB, shed }, { operation: "doc.tags", attempt: 1 }, {}),
    ).rejects.toBeInstanceOf(AiShedError);
  });
});
