# workers-ai-meter

A cost ledger, a spend cap, and a lint rule for **Cloudflare Workers AI** and the AI
Gateway. Every model call is metered, priced in integer micros at write time, and attributable
to whatever unit of your business you care about. It's built so that it's hard to bypass.


```ts
const summary = await meter.run(
  { ai: env.AI, db: env.DB, waitUntil: ctx.waitUntil.bind(ctx), shed, logger },
  { operation: "doc.summarize", subjectId: workspaceId, attempt: 1 },
  { messages },
);
```

## What's in it

| | |
|---|---|
| [`src/meter.ts`](src/meter.ts) | `createMeter()`. The one seam every model call goes through, for both `env.AI.run()` and the AI Gateway provider path (e.g. Gemini). |
| [`src/ledger.ts`](src/ledger.ts) | Three D1 tables: per-attempt rows, a permanent daily roll-up, and a monthly spend counter. |
| [`src/spendCap.ts`](src/spendCap.ts) | Soft cap **alerts**, hard cap **sheds** operations in a stated order, and core operations are never shed. |
| [`src/pricing.ts`](src/pricing.ts) | Integer-micros arithmetic and a checksum that pins the price table to its version. |
| [`eslint/no-unmetered-ai-run.mjs`](eslint/no-unmetered-ai-run.mjs) | Fails lint on any `AI.run` outside the meter, including aliases and destructuring. |
| [`migrations/0001_ai_usage.sql`](migrations/0001_ai_usage.sql) | The schema. |
| [`examples/ai.ts`](examples/ai.ts) | A complete wiring: operations, prices with provenance, and a spend policy. |

## Design decisions

**Money never touches a float.** Prices are integer USD micros per million tokens or per
audio minute. Each cost is computed with one division by a literal and then one `Math.round`.
A ledger that sums floats drifts; this one doesn't.

**Rows are priced at write time and never repriced.** Every row carries a `price_version`.
`computePriceChecksum()` hashes the price fields. Pin it next to the version in a test, and
editing a price without bumping the version fails CI. Historical rows keep meaning what they
meant.

**One row per attempt.** Retries are the cost driver nobody sees. A merged retry reports a
third of the real spend. Failed calls get a row too (zero cost, counted in `errors`), so call
counts catch a tight retry loop even when the tokens are free.

**Reported or estimated, never ambiguous.** Units come from the provider's `usage` block (or
Google's `usageMetadata`, or a WAV header for TTS). When the provider reports nothing, the row is
estimated *and labelled* `units_source: "estimated"`.

**Exactly one owner per failure.** If the ledger write fails, you get one warn event and the
caller still gets its result: metering must never become a new way for a request to fail. If
the model call fails, an error row is written and the **original** error is rethrown (the same
object, not a wrapper), so the caller stays the single owner. Logged events carry the error's class name,
never its message.

**Off the response path, except where there isn't one.** With `waitUntil`, the write happens
after the response. Without it (queue consumers), the write is awaited inline, because a floating
promise in a consumer might never settle. There are tests for both orderings.

**An unknown model fails before it spends.** A missing price throws before the call, not
after. Returning 0 is how spend hides from a ledger.

**The spend cap degrades instead of switching off.** "Over budget, so turn AI off" is the wrong
policy when AI is the product: shedding the core call doesn't save money, it breaks the product
for the user in front of you. The soft cap alerts once a month, using a conditional-`UPDATE` latch
so concurrent isolates can't double-alert. Past the hard cap, operations are shed one step at a
time, least load-bearing first. A shed call never reaches the model and is still recorded, at
zero cost. If the spend counter can't be read, the cap fails open, but it logs an event, so a
database outage can't silently disable the guardrail.

**Unit cost without identity.** `subject_id` is an opaque key you choose (tenant, workspace,
document). `readPerSubjectCost()` groups inside D1 and returns only a distribution (mean, p50,
p90, max) using nearest-rank percentiles, so every number is a cost some real subject incurred.
No identifier ever leaves the function. A test feeds a secret, an email and a name through a
prompt and asserts none of them reach any column.

**Lint makes it structural.** The ESLint rule taints anything shown to hold the binding:
direct access, `c.env.AI`, computed `["AI"]`, single- and multi-hop aliases, destructuring
(including renames), and parameters typed `Ai`. Its comments are honest about the gaps: an
untyped parameter, or the binding passed through an object, gets past it. That's what
`units_source` and AI Gateway reconciliation are for.


## Use it

```bash
npm install github:bhagavansuraj/workers-ai-meter
wrangler d1 migrations create DB ai_usage   # then paste migrations/0001_ai_usage.sql into it
```

```js
// eslint.config.js
import noUnmeteredAiRun from "workers-ai-meter/eslint";
export default [{
  plugins: { local: { rules: { "no-unmetered-ai-run": noUnmeteredAiRun } } },
  rules: { "local/no-unmetered-ai-run": ["error", { allow: ["src/ai.ts"] }] },
}];
```

Then copy [`examples/ai.ts`](examples/ai.ts) and replace the operations and prices with your own.
The prices in the example were read on the dates recorded next to them. Check them again before
you rely on a projection.

## Tests

```bash
npm install && npm run check   # tsc + vitest
```

The ledger, meter and spend-cap tests run inside `workerd` against a real Miniflare D1, via
`@cloudflare/vitest-pool-workers`, with no mocked database. The lint rule runs under ESLint's
`RuleTester` in Node.

## License

[MIT](LICENSE)
