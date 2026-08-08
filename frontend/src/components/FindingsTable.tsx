import { StatusPill, type Tone } from "./ui";
import { STATUS_TONE, STATUS_VERB } from "./FindingsTimeline";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/cn";
import type { Finding, FindingSeverity } from "../types/finding";

interface FindingsTableProps {
  findings: Finding[];
  onSelectFinding: (finding: Finding) => void;
  /** Checkbox selection for report generation (see ReportsPanel.tsx) - ids, not full Finding
   * objects, so selection survives a `findings` refresh untouched. */
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (ids: string[]) => void;
}

/** Only 5 Tone values exist (ui/StatusPill.tsx) for 5 severities - a clean 1:1 fit except
 * high/critical both want the red "critical" tone, differentiated below via the `pulse` prop
 * instead of a 6th tone. */
const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "critical",
  critical: "critical",
};

function typeLabel(type: string): string {
  if (type === "cve") return "CVE";
  return type.replace(/_/g, " ");
}

const HEADERS = ["Severity", "Status", "Type", "Title", "Target", "Tool", "Confidence", "Created", "Updated"];

export function FindingsTable({ findings, onSelectFinding, selectedIds, onToggleSelect, onToggleSelectAll }: FindingsTableProps) {
  if (findings.length === 0) {
    return <p className="text-xs text-muted">No findings match the current filters.</p>;
  }

  const visibleIds = findings.map((f) => f.id);
  const allVisibleSelected = visibleIds.every((id) => selectedIds.has(id));

  return (
    <div className="overflow-x-auto rounded-panel border border-border">
      <table className="w-full min-w-[760px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wide text-muted">
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() => onToggleSelectAll(visibleIds)}
                aria-label={allVisibleSelected ? "Deselect all visible findings" : "Select all visible findings"}
                className="cursor-pointer accent-primary"
              />
            </th>
            {HEADERS.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {findings.map((f) => (
            <tr
              key={f.id}
              onClick={() => onSelectFinding(f)}
              className={cn(
                "cursor-pointer transition-colors hover:bg-card",
                (f.status === "false_positive" || f.status === "duplicate") && "opacity-50",
              )}
            >
              <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(f.id)}
                  onChange={() => onToggleSelect(f.id)}
                  aria-label={`Select finding "${f.title}"`}
                  className="cursor-pointer accent-primary"
                />
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <StatusPill tone={SEVERITY_TONE[f.severity]} pulse={f.severity === "critical"} className="px-2 py-0.5">
                  {f.severity}
                </StatusPill>
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <StatusPill tone={STATUS_TONE[f.status]} dot={false} className="px-2 py-0.5">
                  {STATUS_VERB[f.status]}
                </StatusPill>
              </td>
              <td className="whitespace-nowrap px-3 py-2 capitalize text-muted">{typeLabel(f.type)}</td>
              <td className="max-w-[260px] truncate px-3 py-2 font-medium text-text" title={f.title}>
                {f.title}
              </td>
              <td className="max-w-[200px] truncate px-3 py-2 font-mono text-muted" title={f.target}>
                {f.target}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">{f.tool}</td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">{Math.round(f.confidence * 100)}%</td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">{relativeTime(f.createdAt)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">{relativeTime(f.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
