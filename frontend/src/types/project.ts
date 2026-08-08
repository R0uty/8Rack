export type MissionStatus = "planning" | "active" | "paused" | "completed";

export interface Project {
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
