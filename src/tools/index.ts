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
import { fetchUrlTool } from "./fetchUrl.js";
import { deepResearchTool } from "./deepResearch.js";
import { bgOutputTool, bgKillTool } from "./bg.js";
import { spawnAgentTool } from "./subagent.js";
import { spawnWriteAgentTool } from "./writeAgent.js";
import {
  readDocumentTool,
  writeDocumentTool,
  editSpreadsheetTool,
  editPdfTool,
} from "./document.js";
import { readNotebookTool, editNotebookTool } from "./notebook.js";
import {
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspRenameTool,
} from "./lsp.js";
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
  lspHoverTool,
  lspRenameTool,
  updateTasksTool,
  webSearchTool,
  fetchUrlTool,
  deepResearchTool,
  spawnAgentTool,
  spawnWriteAgentTool,
  readDocumentTool,
  writeDocumentTool,
  editSpreadsheetTool,
  editPdfTool,
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
  lspHoverTool,
  readDocumentTool,
  readNotebookTool,
];
