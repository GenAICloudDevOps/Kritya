// Flat ESLint config (ESLint v9+).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "release/**", ".superpowers/**"],
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
    // Type-aware rules, scoped to src/ only.
    //
    // `tseslint.configs.recommended` above is syntax-only: it never loads the
    // type checker, so the three async rules below were off entirely. That
    // mattered here more than in most codebases, because the core is async end
    // to end — permission prompts, audit writes, MCP calls, background
    // processes, subagents. A dropped `await` on any of those compiled clean
    // and linted clean, then surfaced as an ordering bug at runtime.
    //
    // Deliberately the three rules and not `recommendedTypeChecked`: the full
    // preset is a much larger diff across ~254 files and slows lint
    // considerably, whereas these catch the class of mistake worth paying for.
    // Add more from the preset as the appetite allows.
    //
    // Scoped to src/ because that is what tsconfig.json includes; scripts/*.mjs
    // and the plain-JS Electron files have no project to type-check against.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // A promise nobody awaits or returns: the work may never finish, or may
      // finish after something that assumed it was done. `void` is the escape
      // hatch for the deliberate fire-and-forget case.
      "@typescript-eslint/no-floating-promises": "error",
      // A promise handed to a callback that ignores it — setTimeout, an
      // event handler, an Array.forEach — so the caller cannot await it and
      // rejections become unhandled.
      "@typescript-eslint/no-misused-promises": "error",
      // `await` on something that is not a promise, which usually means the
      // real promise was forgotten one line up.
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Test mocks (e.g. fake fetch calls, loose telemetry payloads) reasonably
    // want looser typing; production code stays strict.
    files: ["src/test/**/*.ts", "src/test/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // The three async rules above are off in tests on purpose. A test that
      // fires a promise it does not await is usually the point — driving a
      // state machine a step at a time, or letting a background write settle
      // while the assertion already ran. Requiring `void` on each one would be
      // ~1400 edits that document nothing, and would bury the ten real hits in
      // production code that this block exists to surface.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
    },
  }
);
