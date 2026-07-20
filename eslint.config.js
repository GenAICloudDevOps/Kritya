// Flat ESLint config (ESLint v9+).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (e.g. scripts/*.mjs) aren't covered by the
    // TypeScript-aware config below, so they need node globals declared
    // explicitly or `console`/`process` trip no-undef.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // Allow intentionally-unused args when prefixed with _.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The shell/hooks tools deliberately execute commands; not a lint concern.
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
