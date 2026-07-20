import type { ToolDef } from "../types.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { shellTool } from "./shell.js";
import { listDirTool } from "./ls.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { updateTasksTool } from "./tasks.js";
import { webSearchTool } from "./webSearch.js";
import { bgOutputTool, bgKillTool } from "./bg.js";
import { spawnAgentTool } from "./subagent.js";
import { spawnWriteAgentTool } from "./writeAgent.js";
import { readDocumentTool, writeDocumentTool } from "./document.js";
import { readNotebookTool, editNotebookTool } from "./notebook.js";
import { lspDefinitionTool, lspReferencesTool, lspDiagnosticsTool } from "./lsp.js";
import { repoMapTool } from "./repoMap.js";

export const ALL_TOOLS: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  bgOutputTool,
  bgKillTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  updateTasksTool,
  webSearchTool,
  spawnAgentTool,
  spawnWriteAgentTool,
  readDocumentTool,
  writeDocumentTool,
  readNotebookTool,
  editNotebookTool,
];

/** Read-only tools a subagent is allowed to use (no writes, edits, or shell). */
export const READONLY_TOOLS: ToolDef[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  readDocumentTool,
  readNotebookTool,
];
