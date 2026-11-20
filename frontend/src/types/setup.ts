/** Mirrors backend/src/services/setupCheck.ts. */
export type SetupItemState = "ok" | "missing" | "warning";

export interface SetupItem {
  id: string;
  label: string;
  state: SetupItemState;
  detail?: string;
  fix?: string;
}

export interface SetupStatus {
  ollama: SetupItem;
  models: SetupItem[];
  tools: SetupItem[];
  ready: boolean;
}
