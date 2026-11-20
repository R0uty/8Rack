import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { FOCUS_RING, StatusPill, type Tone } from "./ui";
import { STATUS_TONE, STATUS_VERB } from "../lib/findingStatus";
import { relativeTime } from "../lib/relativeTime";
import { sortFindings, type SortKey } from "../lib/findingSort";
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

const HEADERS: { label: string; key: SortKey }[] = [
  { label: "Severity", key: "severity" },
  { label: "Status", key: "status" },
  { label: "Type", key: "type" },
  { label: "Title", key: "title" },
  { label: "Target", key: "target" },
  { label: "Tool", key: "tool" },
  { label: "Confidence", key: "confidence" },
  { label: "Created", key: "createdAt" },
  { label: "Updated", key: "updatedAt" },
];

export function FindingsTable({ findings: unsorted, onSelectFinding, selectedIds, onToggleSelect, onToggleSelectAll }: FindingsTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  if (unsorted.length === 0) {
    return <p className="text-xs text-muted">No findings match the current filters.</p>;
  }

  const findings = sortFindings(unsorted, sort?.key ?? null, sort?.dir ?? "asc");
  // First click sorts the way people usually want that column (worst/newest first), the next flips it.
  const toggleSort = (key: SortKey) => {
    const descFirst = key === "severity" || key === "confidence" || key === "createdAt" || key === "updatedAt";
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: descFirst ? "desc" : "asc" },
    );
  };

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
            {HEADERS.map(({ label, key }) => {
              const active = sort?.key === key;
              const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={key}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className="whitespace-nowrap px-3 py-2 font-medium"
                >
                  <button type="button" onClick={() => toggleSort(key)} className={cn("inline-flex items-center gap-1 uppercase hover:text-text", FOCUS_RING, active && "text-text")}>
                    {label}
                    <Icon size={10} aria-hidden />
                  </button>
                </th>
              );
            })}
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
