export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  streaming?: boolean;
  error?: string;
  cancelled?: boolean;
  /** Present on an assistant message that resulted in one or more tool calls. */
  toolCalls?: ToolCallInfo[];
}

export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  num_ctx?: number;
}
