export type MissionStatus =
  | "draft"
  | "ready"
  | "recon"
  | "investigating"
  | "validating"
  | "reporting"
  | "review"
  | "completed"
  | "paused"
  | "cancelled";

export interface Mission {
  id: string;
  name: string;
  notes: string;
  createdAt: number;
  description?: string;
  scope?: string[];
  outOfScope?: string[];
  rules?: string;
  startDate?: number;
  status?: MissionStatus;
}
