export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
}

export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  num_ctx?: number;
}

/** Ollama's native function-calling tool schema, passed in ChatRequest.tools. */
export interface OllamaToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  keep_alive?: string;
  options?: ChatOptions;
  tools?: OllamaToolSpec[];
}

export interface ChatResponseChunk {
  model: string;
  created_at: string;
  message: ChatMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  eval_count?: number;
}
