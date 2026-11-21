import { useMemo, useState } from "react";
import type { ExecToolWithStatus } from "../types/execTool";
import { iconFor, ToolFallbackIcon } from "../lib/icons";
import { GlassPanel, IconButton, SELECT_CLASS, SkeletonRows, StatusPill, Notice } from "./ui";
import { Power } from "lucide-react";

interface ToolRegistryProps {
  tools: ExecToolWithStatus[];
  loading: boolean;
  error: string | null;
  /** Runtime enable/disable toggle - author-level, distinct from `availability` (whether the
   * executable actually resolves on this machine). Omit to render the registry read-only. */
  onToggleEnabled?: (toolId: string, enabled: boolean) => Promise<void>;
}

export function ToolRegistry({ tools, loading, error, onToggleEnabled }: ToolRegistryProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const categories = useMemo(() => [...new Set(tools.map((t) => t.category))].sort(), [tools]);

  const q = query.trim().toLowerCase();
  // What can actually run first - an uninstalled tool is the exception worth seeing last.
  const sorted = [...tools]
    .filter((t) => !category || t.category === category)
    .filter((t) => !onlyMissing || t.availability !== "available")
    .filter((t) => !q || [t.name, t.id, t.description, t.executable].some((field) => field.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.availability === "available") - Number(a.availability === "available"));

  async function handleToggle(tool: ExecToolWithStatus) {
    if (!onToggleEnabled) return;
    setPendingId(tool.id);
    setToggleError(null);
    try {
      await onToggleEnabled(tool.id, !tool.enabled);
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : `Failed to toggle "${tool.name}"`);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section>
      {error && <Notice className="mb-2">{error}</Notice>}
      {toggleError && <Notice className="mb-2">{toggleError}</Notice>}
      {loading && tools.length === 0 && <SkeletonRows count={5} />}
      {!error && !loading && tools.length === 0 && <p className="text-xs text-muted">No tools registered</p>}
      {tools.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Search tools"
            placeholder="Search tools"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-40 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          />
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT_CLASS}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            Not installed only
          </label>
          <span role="status" className="text-[11px] text-muted">
            {sorted.length} of {tools.length}
          </span>
        </div>
      )}
      {tools.length > 0 && sorted.length === 0 && <p className="text-xs text-muted">No tools match.</p>}

      <div className="flex flex-col gap-2">
        {sorted.map((tool) => {
          const Icon = iconFor(tool.icon, ToolFallbackIcon);
          return (
            <GlassPanel
              key={tool.id}
              padding="sm"
              className={`flex items-start gap-2.5 ${tool.enabled ? "" : "opacity-50"}`}
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                <Icon size={13} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text">{tool.name}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!tool.enabled && (
                      <StatusPill tone="neutral" dot={false} className="px-1.5 py-0.5">
                        disabled
                      </StatusPill>
                    )}
                    <StatusPill tone={tool.availability === "available" ? "primary" : "neutral"} dot>
                      {tool.availability}
                    </StatusPill>
                    {onToggleEnabled && (
                      <IconButton
                        icon={Power}
                        label={tool.enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
                        size="sm"
                        active={tool.enabled}
                        disabled={pendingId === tool.id}
                        onClick={() => handleToggle(tool)}
                      />
                    )}
                  </div>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">{tool.description}</p>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono">{tool.category}</span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    title={tool.resolvedPath ?? tool.executable}
                  >
                    {tool.resolvedPath ?? tool.executable}
                  </span>
                  {tool.version && (
                    <span
                      className="max-w-[30%] shrink-0 truncate font-mono text-muted/80"
                      title={tool.version}
                    >
                      {tool.version}
                    </span>
                  )}
                </div>
              </div>
            </GlassPanel>
          );
        })}
      </div>
    </section>
  );
}
