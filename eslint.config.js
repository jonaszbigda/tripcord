import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: importPlugin,
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src/browser",
              message: "core/ must stay environment-agnostic — it cannot import from browser/.",
            },
            {
              target: "./src/core",
              from: "./src/react",
              message: "core/ must stay environment-agnostic — it cannot import from react/.",
            },
          ],
        },
      ],
    },
  },
];
