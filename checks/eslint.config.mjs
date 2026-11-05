// The gate's lint rules for JavaScript and TypeScript, in any project.
// TypeScript gets typescript-eslint's strictest type-checked sets, using the
// tsconfig run.sh writes; JavaScript gets the rules that need no type information.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    linterOptions: { noInlineConfig: true },
  },
  js.configs.recommended,
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
      // typescript-eslint turns these on for TypeScript only.
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
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
);
