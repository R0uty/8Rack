export const MISSION_STATUSES = [
  "draft",
  "ready",
  "recon",
  "investigating",
  "validating",
  "reporting",
  "review",
  "completed",
  "paused",
  "cancelled",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

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
