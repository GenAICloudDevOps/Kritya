// Flat ESLint config (ESLint v9+).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "release/**"],
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
    // Electron main/preload run under Node; the preload script is
    // CommonJS on purpose (see its own comment) so require() is expected.
    files: ["electron/main.mjs", "electron/preload.cjs"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The renderer runs in a browser context (no Node globals), reached
    // only through the `window.kritya` bridge exposed by preload.cjs.
    files: ["electron/renderer/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // Allow intentionally-unused args when prefixed with _.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test mocks (e.g. fake fetch calls, loose telemetry payloads) reasonably
    // want looser typing; production code stays strict.
    files: ["src/test/**/*.ts", "src/test/**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
