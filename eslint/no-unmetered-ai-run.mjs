/**
 * no-unmetered-ai-run: every Workers AI call must go through the meter.
 *
 * An unmetered call site is a silent hole in the bill: it spends money that never reaches the
 * ledger, so unit costs and every projection built on them are quietly wrong. Nine call sites
 * is nine places to forget, so the constraint is structural rather than a convention.
 *
 * The rule taints any expression that can be shown to hold the AI binding and flags
 * `.run(...)` on it. Covered forms (each has a test):
 *
 *   env.AI.run(...)                      direct member
 *   c.env.AI.run(...)                    nested receiver
 *   env["AI"].run(...) / x.AI["run"]()   computed access
 *   const ai = env.AI; ai.run(...)       single-hop alias
 *   const a = env.AI; const b = a; b...  multi-hop alias
 *   const { AI } = env; AI.run(...)      destructuring (incl. renamed)
 *   function f(ai: Ai) { ai.run(...) }   a parameter typed as the binding
 *
 * What it can't see (no lint rule could without type-checking every call graph): an untyped
 * parameter, or the binding smuggled through an object property or a return value. That's why
 * the ledger also carries `units_source` and why AI Gateway reconciliation exists. A rule of
 * this shape narrows the hole; it doesn't seal it.
 *
 * Options: { allow: string[] }: path suffixes allowed to call the binding (your meter
 * wrapper). Default: ["src/meter.ts"]. { binding: string }: the binding name. Default "AI".
 */

/** `.AI`, whether written as `x.AI` or `x["AI"]`. */
function isAiMember(node, binding) {
  if (node?.type !== "MemberExpression") return false;
  const property = node.property;
  if (node.computed) {
    return property?.type === "Literal" && property.value === binding;
  }
  return property?.type === "Identifier" && property.name === binding;
}

/** `.run`, whether written as `x.run` or `x["run"]`. */
function isRunProperty(node) {
  const property = node.property;
  if (node.computed) {
    return property?.type === "Literal" && property.value === "run";
  }
  return property?.type === "Identifier" && property.name === "run";
}

/** A parameter annotated with the Workers AI binding type, e.g. `(ai: Ai)`. */
function isAiTypedParam(param) {
  const annotation = param?.typeAnnotation?.typeAnnotation;
  return (
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "Ai"
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Workers AI calls must go through the meter so every call reaches the cost ledger",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          binding: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unmetered:
        "Unmetered Workers AI call. Go through meter.run() — an unmetered call site is a hole in the AI cost ledger.",
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? "").replace(/\\/g, "/");
    const options = context.options[0] ?? {};
    const allow = options.allow ?? ["src/meter.ts"];
    const binding = options.binding ?? "AI";
    if (allow.some((suffix) => filename.endsWith(suffix))) return {};

    // Identifiers known to hold the binding, by any of the tainting forms.
    const tainted = new Set();

    function taintPattern(id, init) {
      if (id?.type === "Identifier") {
        // const ai = env.AI    (member)
        // const b = a          (multi-hop, `a` already tainted)
        if (isAiMember(init, binding) || (init?.type === "Identifier" && tainted.has(init.name))) {
          tainted.add(id.name);
        }
        return;
      }
      // const { AI } = env  /  const { AI: ai } = env
      if (id?.type === "ObjectPattern") {
        for (const property of id.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const key = property.key;
          const named = key?.type === "Identifier" ? key.name : key?.value;
          if (named === binding && property.value?.type === "Identifier") {
            tainted.add(property.value.name);
          }
        }
      }
    }

    return {
      VariableDeclarator(node) {
        taintPattern(node.id, node.init);
      },
      AssignmentExpression(node) {
        taintPattern(node.left, node.right);
      },
      ":function"(node) {
        for (const param of node.params ?? []) {
          if (isAiTypedParam(param) && param.type === "Identifier") tainted.add(param.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== "MemberExpression" || !isRunProperty(callee)) return;

        const receiver = callee.object;
        const viaProperty = isAiMember(receiver, binding);
        const viaTaint = receiver?.type === "Identifier" && tainted.has(receiver.name);
        if (viaProperty || viaTaint) {
          context.report({ node, messageId: "unmetered" });
        }
      },
    };
  },
};
