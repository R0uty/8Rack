/** Extension point for future agentic tool-calling. Not wired into the chat flow yet. */

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolResult {
  toolName: string;
  output: unknown;
  error?: string;
}

export interface Tool extends ToolDefinition {
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}
