export type MissionEventType =
  | "mission_created"
  | "mission_status_changed"
  | "asset_discovered"
  | "work_order_created"
  | "work_order_started"
  | "work_order_completed"
  | "work_order_failed"
  | "finding_created"
  | "finding_status_changed"
  | "finding_validated"
  | "report_generated"
  | "report_status_changed"
  | "scope_blocked";

export interface MissionEvent {
  id: string;
  missionId: string;
  type: MissionEventType;
  summary: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}
