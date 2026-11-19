import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  // Ledger, meter and spend cap run inside workerd against a real (Miniflare) D1.
  "./vitest.config.ts",
  // ESLint's RuleTester runs in Node.
  { test: { name: "eslint", include: ["test/eslint/**/*.test.ts"], environment: "node" } },
]);
