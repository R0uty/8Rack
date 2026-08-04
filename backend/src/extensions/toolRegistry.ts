import type { Tool, ToolDefinition } from "../types/tool.js";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...tools.values()].map(({ execute: _execute, ...definition }) => definition);
}
