import { useEffect, useMemo, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { ProjectPanel } from "./ProjectPanel";
import { FindingsTable } from "./FindingsTable";
import { FindingsTimeline } from "./FindingsTimeline";
import { FindingsGraphView } from "./FindingsGraphView";
import { FindingDetails } from "./FindingDetails";
import { ReportsPanel } from "./ReportsPanel";
import { AssetsView } from "./AssetsView";
import { ActivityFeed } from "./ActivityFeed";
import { Markdown } from "./Markdown";
import { Button, GlassPanel, SkeletonRows, StreamingCursor } from "./ui";
import { useProjects } from "../hooks/useProjects";
import { useFindings } from "../hooks/useFindings";
import { useReports } from "../hooks/useReports";
import { useActivity } from "../hooks/useActivity";
import { useAgents } from "../hooks/useAgents";
import type { Finding, FindingSeverity } from "../types/finding";
import type { Project } from "../types/project";

type ViewMode = "table" | "timeline" | "graph" | "assets" | "activity" | "reports";
const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "table", label: "Table" },
  { mode: "timeline", label: "Timeline" },
  { mode: "graph", label: "Graph" },
  { mode: "assets", label: "Assets" },
  { mode: "activity", label: "Activity" },
  { mode: "reports", label: "Reports" },
];

const SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

function matchesQuery(f: Finding, query: string): boolean {
  if (!query) return true;
  return [f.title, f.description, f.target, f.tool, f.value, ...f.tags].some((v) => v.toLowerCase().includes(query));
}

export const SELECT_CLASS =
  "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

/** The Findings nav view: pick a project (reusing ProjectPanel, same as Workbench/Plans), then
 * browse/filter/search its findings in a table, with a details drawer on row click. Filtering
 * (severity/type/tool/target/tag/search) is all client-side over the already-fetched list -
 * matches ExecutionHistoryPanel's precedent, no debounce or server-side search in this app. */
export function FindingsView() {
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
    create: createProject,
    update: updateProject,
    remove: removeProject,
  } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { findings, loading, error, update, refresh: refreshFindings } = useFindings(selectedProjectId);
  const { reports, loading: reportsLoading, generating, streamingText, error: reportError, generate, remove: removeReport } =
    useReports(selectedProjectId);
  const {
    executions: activityExecutions,
    tasks: activityTasks,
    loading: activityLoading,
    error: activityError,
  } = useActivity(selectedProjectId);
  const { agents } = useAgents();

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

  useEffect(() => {
    if (selectedProjectId && !projectsLoading && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, projectsLoading, selectedProjectId]);

  // A finding selection made for one project's report shouldn't silently carry over once you
  // switch to another.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectedProjectId]);

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
      setViewMode("reports");
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

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId((current) => (current === project.id ? null : project.id));
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
      <ProjectPanel
        projects={projects}
        loading={projectsLoading}
        error={projectsError}
        selectedProjectId={selectedProjectId}
        onSelect={handleSelectProject}
        onCreate={createProject}
        onUpdate={updateProject}
        onDelete={removeProject}
        onRefresh={refreshProjects}
      />

      {!selectedProjectId && <p className="text-xs text-muted">Select or create a project above to view its findings.</p>}

      {selectedProjectId && (
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

          {(viewMode === "table" || viewMode === "timeline") && (
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

          {error && (viewMode === "table" || viewMode === "timeline" || viewMode === "assets") && (
            <p className="text-xs text-critical">{error}</p>
          )}
          {loading && findings.length === 0 && (viewMode === "table" || viewMode === "timeline" || viewMode === "assets") && (
            <SkeletonRows count={5} />
          )}
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
            <FindingsGraphView projectId={selectedProjectId} onSelectFindingId={handleSelectFindingId} />
          )}
          {!loading && viewMode === "assets" && <AssetsView findings={findings} />}
          {viewMode === "activity" && (
            <ActivityFeed
              executions={activityExecutions}
              tasks={activityTasks}
              agents={agents}
              loading={activityLoading}
              error={activityError}
            />
          )}
          {viewMode === "reports" && (
            <ReportsPanel reports={reports} loading={reportsLoading} error={reportError} onDelete={removeReport} />
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
