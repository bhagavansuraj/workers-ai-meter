import { RuleTester, type Rule } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";
import rule from "../../eslint/no-unmetered-ai-run.mjs";

// The structural constraint: AI.run is legal only inside the meter.
//
// Parsed with the TS parser, because one of the forms the rule must catch is a
// parameter annotated with the binding type (`function f(ai: Ai)`).

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const error = { messageId: "unmetered" as const };
const METER = "/repo/src/meter.ts";
const CALLER = "/repo/src/handlers/summarize.ts";

tester.run("no-unmetered-ai-run", rule as unknown as Rule.RuleModule, {
  valid: [
    // The meter itself is the one place allowed to reach the binding.
    { code: "const run = deps.ai.run; await run(model, inputs);", filename: METER },
    { code: "await env.AI.run(model, inputs);", filename: METER },
    { code: "const { AI } = env; await AI.run(m, i);", filename: METER },
    // Everywhere else, going through the meter is the point.
    { code: "await meter.run(deps, meta, inputs);", filename: CALLER },
    { code: "await queue.run(job);", filename: CALLER },
    { code: "await ai.run(model);", filename: CALLER }, // `ai` never bound from the binding
    { code: "const runner = env.OTHER; await runner.run(x);", filename: CALLER },
    { code: "const { OTHER } = env; await OTHER.run(x);", filename: CALLER },
    { code: "function f(client: Other) { return client.run(m, i); }", filename: CALLER },
    // A custom allow-list and binding name.
    { code: "await env.AI.run(m, i);", filename: "/repo/lib/ai/wrapper.ts", options: [{ allow: ["lib/ai/wrapper.ts"] }] },
    { code: "await env.AI.run(m, i);", filename: CALLER, options: [{ binding: "LLM" }] },
  ],
  invalid: [
    { code: "await env.AI.run(model, inputs);", filename: CALLER, errors: [error] },
    { code: "await c.env.AI.run(model, inputs);", filename: CALLER, errors: [error] },
    // Single-hop alias.
    { code: "const ai = env.AI; await ai.run(model, inputs);", filename: CALLER, errors: [error] },
    {
      code: "function f(c) { const binding = c.env.AI; return binding.run(m, i); }",
      filename: CALLER,
      errors: [error],
    },
    // Computed access on either half of the expression.
    { code: 'await env["AI"].run(model, inputs);', filename: CALLER, errors: [error] },
    { code: 'await env.AI["run"](model, inputs);', filename: CALLER, errors: [error] },
    // Destructuring, plain and renamed.
    { code: "const { AI } = env; await AI.run(m, i);", filename: CALLER, errors: [error] },
    { code: "const { AI: ai } = c.env; await ai.run(m, i);", filename: CALLER, errors: [error] },
    // Multi-hop aliasing.
    {
      code: "const a = env.AI; const b = a; await b.run(m, i);",
      filename: CALLER,
      errors: [error],
    },
    // Reassignment rather than declaration.
    { code: "let ai; ai = env.AI; await ai.run(m, i);", filename: CALLER, errors: [error] },
    // A parameter annotated with the binding type.
    {
      code: "function callIt(ai: Ai) { return ai.run(m, i); }",
      filename: CALLER,
      errors: [error],
    },
    {
      code: "export function realRunAi(ai: Ai) { return async () => ai.run(MODEL, {}); }",
      filename: CALLER,
      errors: [error],
    },
    // The default allow-list stops applying once you configure your own.
    { code: "await env.AI.run(m, i);", filename: METER, options: [{ allow: ["lib/ai/wrapper.ts"] }], errors: [error] },
    { code: "const { LLM } = env; await LLM.run(m, i);", filename: CALLER, options: [{ binding: "LLM" }], errors: [error] },
  ],
});
