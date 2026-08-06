import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ProjectPanel } from "./ProjectPanel";
import { FindingsTable } from "./FindingsTable";
import { FindingsTimeline } from "./FindingsTimeline";
import { FindingsGraphView } from "./FindingsGraphView";
import { FindingDetails } from "./FindingDetails";
import { Button, GlassPanel, SkeletonRows } from "./ui";
import { useProjects } from "../hooks/useProjects";
import { useFindings } from "../hooks/useFindings";
import type { Finding, FindingSeverity } from "../types/finding";
import type { Project } from "../types/project";

type ViewMode = "table" | "timeline" | "graph";
const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "table", label: "Table" },
  { mode: "timeline", label: "Timeline" },
  { mode: "graph", label: "Graph" },
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
    remove: removeProject,
  } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { findings, loading, error, update, refresh: refreshFindings } = useFindings(selectedProjectId);

  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [tool, setTool] = useState("");
  const [target, setTarget] = useState("");
  const [tag, setTag] = useState("");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  useEffect(() => {
    if (selectedProjectId && !projectsLoading && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, projectsLoading, selectedProjectId]);

  const types = useMemo(() => [...new Set(findings.map((f) => f.type))].sort(), [findings]);
  const tools = useMemo(() => [...new Set(findings.map((f) => f.tool))].sort(), [findings]);
  const targets = useMemo(() => [...new Set(findings.map((f) => f.target))].sort(), [findings]);
  const tags = useMemo(() => [...new Set(findings.flatMap((f) => f.tags))].sort(), [findings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) =>
        (!severity || f.severity === severity) &&
        (!type || f.type === type) &&
        (!tool || f.tool === tool) &&
        (!target || f.target === target) &&
        (!tag || f.tags.includes(tag)) &&
        matchesQuery(f, q),
    );
  }, [findings, query, severity, type, tool, target, tag]);

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

          {viewMode !== "graph" && (
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
            </GlassPanel>
          )}

          {error && <p className="text-xs text-critical">{error}</p>}
          {loading && findings.length === 0 && viewMode !== "graph" && <SkeletonRows count={5} />}
          {!loading && viewMode === "table" && <FindingsTable findings={filtered} onSelectFinding={setSelectedFinding} />}
          {!loading && viewMode === "timeline" && (
            <FindingsTimeline findings={filtered} onSelectFinding={setSelectedFinding} />
          )}
          {viewMode === "graph" && (
            <FindingsGraphView projectId={selectedProjectId} onSelectFindingId={handleSelectFindingId} />
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
