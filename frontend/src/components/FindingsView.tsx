import { useEffect, useMemo, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { MissionPanel } from "./MissionPanel";
import { FindingsTable } from "./FindingsTable";
import { FindingsTimeline } from "./FindingsTimeline";
import { FindingsGraphView } from "./FindingsGraphView";
import { FindingDetails } from "./FindingDetails";
import { Markdown } from "./Markdown";
import { Button, GlassPanel, SELECT_CLASS, SectionHeading, SkeletonRows, StatusPill, StreamingCursor, type Tone } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useFindings } from "../hooks/useFindings";
import { useReports } from "../hooks/useReports";
import { relativeTime } from "../lib/relativeTime";
import type { EvidenceType, Finding, FindingSeverity } from "../types/finding";
import type { Mission } from "../types/mission";

// Assets/Activity/Reports were extracted to their own top-level nav views (AssetsView,
// MissionsView, ReportsView). Evidence briefly got the same treatment but was folded back in here
// as a tab - it's purely a client-side reshape of Finding.evidence, never listed independently of
// its parent finding, so a whole nav item for it added more surface than it earned; a full page of
// findings-browsing tools is what Findings owns.
type ViewMode = "table" | "timeline" | "graph" | "evidence";
const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "table", label: "Table" },
  { mode: "timeline", label: "Timeline" },
  { mode: "graph", label: "Graph" },
  { mode: "evidence", label: "Evidence" },
];

const SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

const EVIDENCE_TYPE_TONE: Record<EvidenceType, Tone> = {
  http_request: "info",
  http_response: "info",
  terminal_output: "neutral",
  tool_result: "primary",
  agent_reasoning: "warning",
  note: "neutral",
};

interface EvidenceRow {
  id: string;
  type: EvidenceType;
  content: string;
  createdAt: number;
  agentId?: string;
  executionId?: string;
  findingId: string;
  findingTitle: string;
}

function matchesQuery(f: Finding, query: string): boolean {
  if (!query) return true;
  return [f.title, f.description, f.target, f.tool, f.value, ...f.tags].some((v) => v.toLowerCase().includes(query));
}

/** The Findings nav view: pick a mission (reusing MissionPanel, same as Workbench/Plans), then
 * browse/filter/search its findings in a table, with a details drawer on row click. Filtering
 * (severity/type/tool/target/tag/search) is all client-side over the already-fetched list -
 * matches ExecutionHistoryPanel's precedent, no debounce or server-side search in this app. */
export function FindingsView() {
  const {
    missions,
    loading: missionsLoading,
    error: missionsError,
    refresh: refreshMissions,
    create: createMission,
    update: updateMission,
    remove: removeMission,
  } = useMissions();
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const { findings, loading, error, update, refresh: refreshFindings } = useFindings(selectedMissionId);
  const { generating, streamingText, error: reportError, generate } = useReports(selectedMissionId);

  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [tool, setTool] = useState("");
  const [target, setTarget] = useState("");
  const [tag, setTag] = useState("");
  const [minConfidence, setMinConfidence] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reportTitle, setReportTitle] = useState("");
  const [evidenceType, setEvidenceType] = useState("");
  const [evidenceFinding, setEvidenceFinding] = useState("");
  const [evidenceAgent, setEvidenceAgent] = useState("");

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((p) => p.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  // A finding selection (report checkboxes, or the details drawer) made for one mission shouldn't
  // silently carry over once you switch to another - the drawer previously kept showing the old
  // mission's finding object indefinitely (findings.find() misses it in the new list and falls
  // back to the stale one), and an update issued from it would PATCH the wrong mission's finding.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectedFinding(null);
  }, [selectedMissionId]);

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
  const tools = useMemo(() => [...new Set(findings.map((f) => f.tool))].sort(), [findings]);
  const targets = useMemo(() => [...new Set(findings.map((f) => f.target))].sort(), [findings]);
  const tags = useMemo(() => [...new Set(findings.flatMap((f) => f.tags))].sort(), [findings]);
  // An "agent" here is anything that touched the finding as an agent - either the finding's own
  // `tool` (when agent-sourced) or an entry in `relatedAgents` (e.g. a validator that re-confirmed
  // a scanner-sourced finding) - distinct from `tools`, which also includes non-agent tool ids.
  const agentOptions = useMemo(
    () =>
      [...new Set(findings.flatMap((f) => [...(f.source === "agent" ? [f.tool] : []), ...f.relatedAgents]))].sort(),
    [findings],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const minConf = minConfidence ? Number(minConfidence) : undefined;
    return findings.filter(
      (f) =>
        (!severity || f.severity === severity) &&
        (!type || f.type === type) &&
        (!tool || f.tool === tool) &&
        (!target || f.target === target) &&
        (!tag || f.tags.includes(tag)) &&
        (minConf === undefined || f.confidence >= minConf) &&
        (!agentFilter || f.tool === agentFilter || f.relatedAgents.includes(agentFilter)) &&
        matchesQuery(f, q),
    );
  }, [findings, query, severity, type, tool, target, tag, minConfidence, agentFilter]);

  const evidenceRows = useMemo<EvidenceRow[]>(
    () =>
      findings
        .flatMap((f) => f.evidence.map((e) => ({ ...e, findingId: f.id, findingTitle: f.title })))
        .sort((a, b) => b.createdAt - a.createdAt),
    [findings],
  );
  const evidenceAgentOptions = useMemo(
    () => [...new Set(evidenceRows.map((r) => r.agentId).filter((a): a is string => !!a))].sort(),
    [evidenceRows],
  );
  const filteredEvidence = evidenceRows.filter(
    (r) =>
      (!evidenceType || r.type === evidenceType) &&
      (!evidenceFinding || r.findingId === evidenceFinding) &&
      (!evidenceAgent || r.agentId === evidenceAgent),
  );

  const filtersActive = !!(query || severity || type || tool || target || tag || minConfidence || agentFilter);
  // Graph mode doesn't refetch/reshape its data per filter (it's a separate endpoint keyed only on
  // missionId) - instead the filter bar above dims non-matching nodes in place, so switching
  // between Table/Graph keeps the same filters visibly in effect either way. `null` when no filter
  // is active tells the graph to skip the dimming/match-count treatment entirely.
  const visibleFindingIds = useMemo(
    () => (filtersActive ? new Set(filtered.map((f) => f.id)) : null),
    [filtersActive, filtered],
  );

  const handleSelectMission = (mission: Mission) => {
    setSelectedMissionId((current) => (current === mission.id ? null : mission.id));
  };

  // The graph only knows node ids, not full Finding objects (see types/finding.ts's
  // FindingsGraphNode) - resolve against the already-fetched list before opening the drawer.
  const handleSelectFindingId = (id: string) => {
    const finding = findings.find((f) => f.id === id);
    if (finding) setSelectedFinding(finding);
  };

  // Keeps the drawer's content in sync (e.g. after a status update) rather than pointing at a
  // stale object once `findings` refreshes.
  const openFinding = selectedFinding ? findings.find((f) => f.id === selectedFinding.id) ?? selectedFinding : null;

  return (
    <div className="flex flex-col gap-4">
      <MissionPanel
        missions={missions}
        loading={missionsLoading}
        error={missionsError}
        selectedMissionId={selectedMissionId}
        onSelect={handleSelectMission}
        onCreate={createMission}
        onUpdate={updateMission}
        onDelete={removeMission}
        onRefresh={refreshMissions}
      />

      {!selectedMissionId && <p className="text-xs text-muted">Select or create a mission above to view its findings.</p>}

      {selectedMissionId && (
        <>
          <div className="flex gap-1.5">
            {VIEW_MODES.map(({ mode, label }) => (
              <Button
                key={mode}
                variant={viewMode === mode ? "primary" : "secondary"}
                size="sm"
                onClick={() => setViewMode(mode)}
              >
                {label}
              </Button>
            ))}
          </div>

          {(viewMode === "table" || viewMode === "timeline" || viewMode === "graph") && (
            <GlassPanel padding="md" className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 basis-56">
                <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, description, target…"
                  className="w-full rounded-lg border border-border bg-surface-2 py-1.5 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
                />
              </div>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={SELECT_CLASS}>
                <option value="">All severities</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select value={type} onChange={(e) => setType(e.target.value)} className={SELECT_CLASS}>
                <option value="">All types</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <select value={tool} onChange={(e) => setTool(e.target.value)} className={SELECT_CLASS}>
                <option value="">All tools</option>
                {tools.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {targets.length > 1 && (
                <select value={target} onChange={(e) => setTarget(e.target.value)} className={SELECT_CLASS}>
                  <option value="">All targets</option>
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              {tags.length > 0 && (
                <select value={tag} onChange={(e) => setTag(e.target.value)} className={SELECT_CLASS}>
                  <option value="">All tags</option>
                  {tags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              <select value={minConfidence} onChange={(e) => setMinConfidence(e.target.value)} className={SELECT_CLASS}>
                <option value="">Any confidence</option>
                <option value="0.5">≥ 50%</option>
                <option value="0.7">≥ 70%</option>
                <option value="0.9">≥ 90%</option>
              </select>
              {agentOptions.length > 0 && (
                <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className={SELECT_CLASS}>
                  <option value="">All agents</option>
                  {agentOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              )}
            </GlassPanel>
          )}

          {viewMode === "table" && selectedIds.size > 0 && (
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
                <Button
                  variant="primary"
                  size="sm"
                  icon={Sparkles}
                  onClick={handleGenerateReport}
                  disabled={!reportTitle.trim() || generating}
                >
                  {generating ? "Generating…" : "Generate Report"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={X}
                  onClick={() => setSelectedIds(new Set())}
                  disabled={generating}
                >
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

          {error && (viewMode === "table" || viewMode === "timeline") && <p className="text-xs text-critical">{error}</p>}
          {loading && findings.length === 0 && (viewMode === "table" || viewMode === "timeline") && <SkeletonRows count={5} />}
          {!loading && viewMode === "table" && (
            <FindingsTable
              findings={filtered}
              onSelectFinding={setSelectedFinding}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
          )}
          {!loading && viewMode === "timeline" && (
            <FindingsTimeline findings={filtered} onSelectFinding={setSelectedFinding} />
          )}
          {viewMode === "graph" && (
            <FindingsGraphView
              missionId={selectedMissionId}
              onSelectFindingId={handleSelectFindingId}
              visibleFindingIds={visibleFindingIds}
            />
          )}

          {viewMode === "evidence" && (
            <>
              <SectionHeading>Evidence ({filteredEvidence.length})</SectionHeading>

              {evidenceRows.length > 0 && (
                <GlassPanel padding="md" className="flex flex-wrap items-center gap-2">
                  <select value={evidenceType} onChange={(e) => setEvidenceType(e.target.value)} className={SELECT_CLASS}>
                    <option value="">All types</option>
                    {(Object.keys(EVIDENCE_TYPE_TONE) as EvidenceType[]).map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <select value={evidenceFinding} onChange={(e) => setEvidenceFinding(e.target.value)} className={SELECT_CLASS}>
                    <option value="">All findings</option>
                    {findings.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.title}
                      </option>
                    ))}
                  </select>
                  {evidenceAgentOptions.length > 0 && (
                    <select value={evidenceAgent} onChange={(e) => setEvidenceAgent(e.target.value)} className={SELECT_CLASS}>
                      <option value="">All agents</option>
                      {evidenceAgentOptions.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  )}
                </GlassPanel>
              )}

              {evidenceRows.length === 0 && <p className="text-xs text-muted">No evidence recorded yet for this mission.</p>}

              <div className="flex flex-col gap-2">
                {filteredEvidence.map((row) => (
                  <GlassPanel key={row.id} padding="md">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <StatusPill tone={EVIDENCE_TYPE_TONE[row.type]} dot={false} className="px-1.5 py-0.5">
                        {row.type.replace(/_/g, " ")}
                      </StatusPill>
                      <span className="text-xs text-muted">from</span>
                      <span className="text-xs text-text">{row.findingTitle}</span>
                      {row.agentId && <span className="text-[11px] text-muted">· {row.agentId}</span>}
                      <span className="ml-auto text-[11px] text-muted">{relativeTime(row.createdAt)}</span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 px-2.5 py-2 text-xs text-text">
                      {row.content}
                    </pre>
                  </GlassPanel>
                ))}
              </div>
            </>
          )}
        </>
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
