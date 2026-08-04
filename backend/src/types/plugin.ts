/** Extension point for future plugin loading. Not implemented yet. */

import type { Tool } from "./tool.js";
import type { Scanner } from "./scanner.js";
import type { RetrievalSource } from "./rag.js";

export interface PluginContext {
  registerTool: (tool: Tool) => void;
  registerScanner: (scanner: Scanner) => void;
  registerRetrievalSource: (source: RetrievalSource) => void;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  register: (context: PluginContext) => void;
}
