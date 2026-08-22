import { useMemo, useState } from "react";
import { SELECT_CLASS, StatusDot } from "./ui";
import { FINDING_STATUSES, STATUS_TONE, STATUS_VERB } from "../lib/findingStatus";
import { relativeTime } from "../lib/relativeTime";
import type { Finding, FindingHistoryEntry } from "../types/finding";

interface FindingsTimelineProps {
  findings: Finding[];
  onSelectFinding: (finding: Finding) => void;
}

interface TimelineEvent extends FindingHistoryEntry {
  finding: Finding;
}

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** Groups an already-sorted (newest-first) event list into consecutive same-day buckets, without
 * re-sorting - order of appearance already reflects chronological order. */
function groupByDay(events: TimelineEvent[]): { label: string; events: TimelineEvent[] }[] {
  const groups: { label: string; events: TimelineEvent[] }[] = [];
  for (const event of events) {
    const label = dayLabel(event.at);
    const last = groups.at(-1);
    if (last && last.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
}

/** Every finding already carries a full history[] from GET /api/missions/:id/findings - no new
 * backend call needed. Flattens every finding's history into one mission-wide, newest-first,
 * filterable, day-grouped timeline. */
export function FindingsTimeline({ findings, onSelectFinding }: FindingsTimelineProps) {
  const [statusFilter, setStatusFilter] = useState("");

  const groups = useMemo(() => {
    const events: TimelineEvent[] = findings
      .flatMap((finding) => finding.history.map((entry) => ({ ...entry, finding })))
      .filter((e) => !statusFilter || e.status === statusFilter)
      .sort((a, b) => b.at - a.at);
    return groupByDay(events);
  }, [findings, statusFilter]);

  return (
    <div className="flex flex-col gap-3">
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${SELECT_CLASS} self-start`}>
        <option value="">All events</option>
        {FINDING_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_VERB[s]}
          </option>
        ))}
      </select>

      {groups.length === 0 && <p className="text-xs text-muted">No timeline events yet.</p>}

      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.label}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.label}</h3>
            <div className="flex flex-col gap-1">
              {group.events.map((event, i) => (
                <button
                  key={`${event.finding.id}-${event.at}-${i}`}
                  type="button"
                  onClick={() => onSelectFinding(event.finding)}
                  className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-card"
                >
                  <StatusDot tone={STATUS_TONE[event.status]} />
                  <span className="font-medium text-text">{STATUS_VERB[event.status]}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{event.finding.title}</span>
                  <span className="shrink-0 text-muted">{relativeTime(event.at)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
