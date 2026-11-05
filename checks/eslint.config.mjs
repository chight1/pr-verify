// The gate's lint rules for JavaScript and TypeScript, in any project.
// TypeScript gets typescript-eslint's strictest type-checked sets, using the
// tsconfig run.sh writes; JavaScript gets the rules that need no type information.
// Both get SonarJS's recommended rules and its checks for common mistakes.
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const MAX_COGNITIVE_COMPLEXITY = 15;
const MAX_CYCLOMATIC_COMPLEXITY = 10;
const MAX_NESTING_DEPTH = 3;
const MAX_FUNCTION_LINES = 50;
const MAX_PARAMETERS = 5;

const TESTS = [
  "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/{test,tests,__tests__}/**",
];

export default defineConfig(
  {
    linterOptions: { noInlineConfig: true },
  },
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: process.env.PR_VERIFY_TSCONFIG,
        tsconfigRootDir: process.cwd(),
      },
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    extends: [tseslint.configs.strict, tseslint.configs.stylistic],
  },
  {
    rules: {
      // Numbers other than 0, 1 and -1 are named where they are declared: a
      // constant, an enum member, a readonly field, a type or a default value.
      "no-magic-numbers": "off",
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
          enforceConst: true,
        },
      ],
      // A command found on PATH is how every program runs a tool; replacing it
      // means already controlling PATH. Semgrep follows untrusted input to a
      // command where it matters.
      "sonarjs/no-os-command-from-path": "off",
      // Size and complexity limits, the same in every language.
      "sonarjs/cognitive-complexity": ["error", MAX_COGNITIVE_COMPLEXITY],
      complexity: ["error", MAX_CYCLOMATIC_COMPLEXITY],
      "max-depth": ["error", MAX_NESTING_DEPTH],
      "max-lines-per-function": [
        "error",
        { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true },
      ],
      "max-params": ["error", MAX_PARAMETERS],
      // Names that say nothing about what they hold, where the code declares
      // them. A property key can belong to someone else's API.
      "id-match": [
        "error",
        "^(?!(?:pos|idx|cnt|tmp|val|obj|res|ret|lib|mgr|data|info)$)",
        { properties: false, onlyDeclarations: true },
      ],
      // typescript-eslint turns these on for TypeScript only.
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      // Debug output left in. A command-line tool writes to process.stdout.
      "no-console": "error",
      // A task comment that names the issue tracking it is allowed, as in Python.
      "sonarjs/todo-tag": "off",
      "sonarjs/comment-regex": [
        "error",
        {
          regularExpression: String.raw`\b(TODO|FIXME|XXX|HACK)\b(?![^\n]*(#\d+|https?://))`,
          message: "Name the issue that tracks this, as TODO(#123).",
        },
      ],
      // No @ts- comment of any kind, with or without a description.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
        },
      ],
    },
  },
  {
    // Tests that cannot fail: no assertion, an assertion behind a condition, or a
    // test that is skipped or focused. Tests compare against literal values.
    files: TESTS,
    plugins: { vitest },
    rules: {
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*", "assert", "assert*"] },
      ],
      "vitest/no-conditional-expect": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
      "@typescript-eslint/no-magic-numbers": "off",
      // A describe block groups tests; its length is the number of tests.
      "max-lines-per-function": "off",
    },
  },
);
