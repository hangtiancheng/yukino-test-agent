//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config";

export default [
  ...tanstackConfig,
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      // Structural interfaces (e.g. PageLike) rely on method-signature
      // bivariance to accept Playwright types without importing them.
      "@typescript-eslint/method-signature-style": "off",
      // Server code deliberately guards DB trust boundaries (JSONB columns,
      // rows[0] access, persisted analysis payloads) whose TypeScript types
      // are optimistic; the defensive `?? []` / `if (!row)` checks are
      // intentional runtime safety, not dead code.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    ignores: [
      ".legacy",
      "eslint.config.js",
      "prettier.config.js",
      ".output/**",
      ".vinxi/**",
      "src/routeTree.gen.ts",
      // Standalone analysis fixture (Go + Lit with its own toolchain).
      "scripts/sample-src/**",
    ],
  },
];
