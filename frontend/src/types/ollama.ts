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
  /** Ollama's own capability tags - "completion", "tools", "embedding", "thinking", "insert", ...
   *  Absent on older Ollama versions, which is why every consumer must fail open. */
  capabilities?: string[];
}
