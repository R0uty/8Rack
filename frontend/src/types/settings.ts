export interface Settings {
  temperature: number;
  topP: number;
  /** 0 means unlimited (num_predict omitted from the request). */
  maxTokens: number;
  /** 0 means use the model's default context size (num_ctx omitted). */
  contextSize: number;
  keepAlive: string;
}

export const DEFAULT_SETTINGS: Settings = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 0,
  contextSize: 0,
  keepAlive: "5m",
};
