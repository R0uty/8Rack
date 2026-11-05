import { useEffect, useMemo, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { FindingsTable } from "./FindingsTable";
import { FindingDetails } from "./FindingDetails";
import { Markdown } from "./Markdown";
import { NoMission } from "./NoMission";
import { Button, GlassPanel, SELECT_CLASS, SkeletonRows, StreamingCursor } from "./ui";
import { useFindings } from "../hooks/useFindings";
import { useReports } from "../hooks/useReports";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { FINDING_STATUSES } from "../lib/findingStatus";
import type { Finding, FindingSeverity } from "../types/finding";
import type { Mission } from "../types/mission";

const SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

function matchesQuery(f: Finding, query: string): boolean {
  if (!query) return true;
  return [f.title, f.description, f.target, f.tool, f.value, ...f.tags].some((v) => v.toLowerCase().includes(query));
}

/** A mission's findings: search and filter them, open one for its evidence and actions, or tick some
 * to generate a report. Filtering is client-side over the already-fetched list. */
export function FindingsView({ mission, active = true }: { mission: Mission | null; active?: boolean }) {
  const missionId = mission?.id ?? null;
  const { findings, loading, error, update, refresh: refreshFindings } = useFindings(missionId);
  const { generating, streamingText, error: reportError, generate } = useReports(missionId);
  useRefreshOnActivate(active, refreshFindings);

  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reportTitle, setReportTitle] = useState("");

  // A finding selection (report checkboxes, or the details drawer) made for one mission shouldn't
  // silently carry over once you switch to another - the drawer previously kept showing the old
  // mission's finding object indefinitely (findings.find() misses it in the new list and falls
  // back to the stale one), and an update issued from it would PATCH the wrong mission's finding.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectedFinding(null);
  }, [missionId]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      if (allSelected) return new Set([...prev].filter((id) => !ids.includes(id)));
      return new Set([...prev, ...ids]);
    });
  };

  const handleGenerateReport = async () => {
    if (!reportTitle.trim() || selectedIds.size === 0 || generating) return;
    const report = await generate(reportTitle.trim(), [...selectedIds]);
    if (report) {
      setSelectedIds(new Set());
      setReportTitle("");
    }
  };

  const types = useMemo(() => [...new Set(findings.map((f) => f.type))].sort(), [findings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) => (!severity || f.severity === severity) && (!status || f.status === status) && (!type || f.type === type) && matchesQuery(f, q),
    );
  }, [findings, query, severity, status, type]);

  // Keeps the drawer's content in sync (e.g. after a status update) rather than pointing at a
  // stale object once `findings` refreshes.
  const openFinding = selectedFinding ? findings.find((f) => f.id === selectedFinding.id) ?? selectedFinding : null;

  if (!mission) return <NoMission />;

  return (
    <div className="flex flex-col gap-4">
      {findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 basis-56">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              aria-label="Search findings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, description, target…"
              className="w-full rounded-lg border border-border bg-surface-2 py-1.5 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
            />
          </div>
          <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className={SELECT_CLASS}>
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT_CLASS}>
            <option value="">All statuses</option>
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={SELECT_CLASS}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedIds.size > 0 && (
        <GlassPanel padding="md" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">
              {selectedIds.size} finding{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            <input
              value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)}
              placeholder="Report title, e.g. Security Assessment — example.com"
              disabled={generating}
              className="min-w-56 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
            />
            <Button variant="primary" size="sm" icon={Sparkles} onClick={handleGenerateReport} disabled={!reportTitle.trim() || generating}>
              {generating ? "Generating…" : "Generate Report"}
            </Button>
            <Button variant="ghost" size="sm" icon={X} onClick={() => setSelectedIds(new Set())} disabled={generating}>
              Clear
            </Button>
          </div>
          {reportError && <p className="text-xs text-critical">{reportError}</p>}
          {generating && streamingText && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-surface-2 p-3">
              <Markdown content={streamingText} />
              <StreamingCursor />
            </div>
          )}
        </GlassPanel>
      )}

      {error && <p className="text-xs text-critical">{error}</p>}
      {loading && findings.length === 0 && <SkeletonRows count={5} />}
      {!loading && findings.length === 0 && !error && (
        <p className="text-xs text-muted">No findings yet - advance the factory or run a scan to discover some.</p>
      )}
      {!loading && findings.length > 0 && (
        <FindingsTable
          findings={filtered}
          onSelectFinding={setSelectedFinding}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
        />
      )}

      <FindingDetails
        finding={openFinding}
        findings={findings}
        onClose={() => setSelectedFinding(null)}
        onUpdate={update}
        onSelectRelated={setSelectedFinding}
        onRefresh={refreshFindings}
      />
    </div>
  );
}
