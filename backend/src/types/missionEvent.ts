/**
 * The Mission Activity Timeline's event vocabulary - an explicit, named audit trail distinct from
 * ActivityFeed.tsx's older client-side merge of tool executions + orchestrator task transcripts
 * (still useful for execution-level detail, but doesn't capture asset/finding/report/scope-block
 * events at all). See services/activityLog.ts.
 */
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
  /** Human-readable one-line description, e.g. "Recon Agent's nmap execution was blocked - target
   * outside scope" - rendered directly by ActivityFeed.tsx, no client-side formatting needed. */
  summary: string;
  createdAt: number;
  /** Event-specific structured detail (offending targets, old/new status, verdict, ...) - free-form
   * since each event type's shape differs; consumers that care about a specific field read it
   * directly rather than this being a discriminated union, to keep MissionEvent itself simple. */
  meta?: Record<string, unknown>;
}
