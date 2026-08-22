import { Activity } from "lucide-react";
import type { MissionEvent, MissionEventType } from "../types/missionEvent";
import { relativeTime } from "../lib/relativeTime";
import { GlassPanel, SkeletonRows, StatusPill, type Tone } from "./ui";

interface ActivityFeedProps {
  events: MissionEvent[];
  loading: boolean;
  error: string | null;
}

const EVENT_TONE: Record<MissionEventType, Tone> = {
  mission_created: "neutral",
  mission_status_changed: "neutral",
  asset_discovered: "info",
  work_order_created: "info",
  work_order_started: "info",
  work_order_completed: "primary",
  work_order_failed: "critical",
  finding_created: "info",
  finding_status_changed: "neutral",
  finding_validated: "primary",
  report_generated: "primary",
  report_status_changed: "neutral",
  scope_blocked: "critical",
};

const EVENT_LABEL: Record<MissionEventType, string> = {
  mission_created: "mission",
  mission_status_changed: "mission",
  asset_discovered: "asset",
  work_order_created: "work order",
  work_order_started: "work order",
  work_order_completed: "work order",
  work_order_failed: "work order",
  finding_created: "finding",
  finding_status_changed: "finding",
  finding_validated: "finding",
  report_generated: "report",
  report_status_changed: "report",
  scope_blocked: "scope",
};

/**
 * The Mission Activity Timeline - an explicit, named-event log (see backend/src/services/
 * activityLog.ts and hooks/useActivity.ts) covering every mission-scoped action: assets
 * discovered, work orders created/started/settled, findings created/validated, reports generated,
 * mission status changes, and blocked out-of-scope executions - the factory's full audit trail.
 */
export function ActivityFeed({ events, loading, error }: ActivityFeedProps) {
  if (error) return <p className="text-xs text-critical">{error}</p>;
  if (loading && events.length === 0) return <SkeletonRows count={5} />;
  if (events.length === 0) return <p className="text-xs text-muted">No activity yet for this mission.</p>;

  return (
    <div className="flex flex-col gap-1.5">
      {events.map((event) => (
        <GlassPanel key={event.id} padding="sm" className="flex items-center gap-2.5">
          <Activity size={13} className="shrink-0 text-muted" />
          <StatusPill tone={EVENT_TONE[event.type]} dot={false} className="shrink-0 px-1.5 py-0.5">
            {EVENT_LABEL[event.type]}
          </StatusPill>
          <span className="min-w-0 flex-1 truncate text-xs text-text">{event.summary}</span>
          <span className="shrink-0 text-[11px] text-muted">{relativeTime(event.createdAt)}</span>
        </GlassPanel>
      ))}
    </div>
  );
}
