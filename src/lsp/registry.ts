import path from "node:path";

/** One language server kritya knows how to spawn. */
export interface LspServerConfig {
  /** Stable id — one server process is kept per (workspace, id). */
  id: string;
  command: string;
  args: string[];
  /** Shown when the binary is missing so the user can install it. */
  installHint: string;
  /** Maps a file extension (without dot) to the LSP languageId. */
  languageIds: Record<string, string>;
}

const SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    installHint: "npm install -g typescript-language-server typescript",
    languageIds: {
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascriptreact",
    },
  },
  {
    id: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    installHint: "npm install -g pyright",
    languageIds: { py: "python", pyi: "python" },
  },
  {
    id: "go",
    command: "gopls",
    args: [],
    installHint: "go install golang.org/x/tools/gopls@latest",
    languageIds: { go: "go" },
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    installHint: "rustup component add rust-analyzer",
    languageIds: { rs: "rust" },
  },
  {
    id: "clangd",
    command: "clangd",
    args: [],
    installHint: "install clangd via your OS package manager (apt/brew/winget)",
    languageIds: { c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", hh: "cpp" },
  },
];

/** Find the language server responsible for a file, or null if none is known. */
export function serverForFile(filePath: string): LspServerConfig | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!ext) return null;
  return SERVERS.find((s) => ext in s.languageIds) ?? null;
}

export function languageIdForFile(config: LspServerConfig, filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return config.languageIds[ext] ?? "plaintext";
}

/** Extensions kritya can serve at all — used for the tool description. */
export function supportedExtensions(): string[] {
  return SERVERS.flatMap((s) => Object.keys(s.languageIds));
}
