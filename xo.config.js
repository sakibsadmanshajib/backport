/* eslint-disable import-x/no-default-export */
import sortDestructureKeys from "eslint-plugin-sort-destructure-keys";

// NOTE: eslint-plugin-typescript-sort-keys@3 uses the removed context.getSourceCode()
// API and is incompatible with ESLint 9 (xo v2). Re-enable once an ESLint-9-compatible
// release is available. Tracked known regression: ESLint 9 removed context.getSourceCode().
// Tracked rules: typescript-sort-keys/interface, typescript-sort-keys/string-enum.

/** @type {import('xo').FlatXoConfig} */
export default [
  {
    plugins: {
      "sort-destructure-keys": sortDestructureKeys,
    },
    prettier: "compat",
    rules: {
      // Ban-types was removed in @typescript-eslint v8; off to silence "not found".
      "@typescript-eslint/ban-types": "off",
      // Index signatures are slightly more legible since the key must be named.
      "@typescript-eslint/consistent-indexed-object-style": [
        "error",
        "index-signature",
      ],
      // GitHub uses snake_case in its returned payloads.
      "@typescript-eslint/naming-convention": "off",
      // Pre-existing deprecated Zod API usage; defer to a follow-up.
      "@typescript-eslint/no-deprecated": "off",
      // Null is used intentionally in SDK/API response types.
      "@typescript-eslint/no-restricted-types": "off",
      // Pre-existing unsafe calls in scripts/tests; new in xo v2.
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // Pre-existing as-casts throughout src/test; defer to a follow-up.
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      // Too restrictive.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Pre-existing strict-void-return issues in callbacks; new in xo v2.
      "@typescript-eslint/strict-void-return": "off",
      // Covered by TypeScript.
      "default-case": "off",
      // Forbid function declarations.
      "func-style": ["error", "expression", { allowArrowFunctions: true }],
      // Import/no-extraneous-dependencies was replaced by import-x in xo v2.
      "import/no-extraneous-dependencies": "off",
      // Already taken care of by TypeScript.
      "import-x/namespace": "off",
      // Named exports are better for static analysis.
      "import-x/no-default-export": "error",
      "import-x/no-namespace": "error",
      "no-console": "error",
      "object-shorthand": [
        "error",
        "always",
        { avoidExplicitReturnArrows: true },
      ],
      // Pre-existing catch-error patterns throughout src; new in xo v2.
      "preserve-caught-error": "off",
      // Existing regexps lack the v flag throughout; new in xo v2.
      "require-unicode-regexp": "off",
      "sort-destructure-keys/sort-destructure-keys": [
        "error",
        { caseSensitive: false },
      ],
      "sort-imports": ["error", { ignoreDeclarationSort: true }],
      "sort-keys": [
        "error",
        "asc",
        { caseSensitive: false, minKeys: 2, natural: true },
      ],
    },
  },
  {
    // Vitest config files must use default exports (required by vitest).
    files: ["vitest.config.mts", "vitest.live.config.mts"],
    rules: {
      "import-x/no-default-export": "off",
    },
  },
  {
    // Prevent production source files from importing devDependencies (e.g. vitest, xo).
    files: ["src/**/*.ts"],
    rules: {
      "import-x/no-extraneous-dependencies": [
        "error",
        { devDependencies: false },
      ],
    },
  },
  {
    files: ["test/**", "scripts/**"],
    rules: {
      // Curly-newline conflicts with prettier formatting of destructures.
      "@stylistic/curly-newline": "off",
      // Unnecessary-type-assertion false positives on non-null assertions in tests.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Test/script files import vitest and other devDependencies.
      "import-x/no-extraneous-dependencies": "off",
      // Tests use function expressions for vi.fn mocks (vitest v4 requirement).
      "prefer-arrow-callback": "off",
    },
  },
];
