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

export const ALL_TOOLS: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  listDirTool,
  globTool,
  grepTool,
  updateTasksTool,
  webSearchTool,
];
