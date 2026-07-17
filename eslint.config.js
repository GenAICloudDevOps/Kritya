// Flat ESLint config (ESLint v9+).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
