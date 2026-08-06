import { useMemo, useState } from "react";
import { Bookmark, BookmarkCheck, ChevronDown, RefreshCw, Search } from "lucide-react";
import { ExecutionConsole } from "./ExecutionConsole";
import { GlassPanel, IconButton, SectionHeading, StatusPill, type Tone } from "./ui";
import { useBookmarks } from "../hooks/useBookmarks";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/cn";
import type { ExecutionRecord, ExecutionStatus } from "../types/execTool";

interface ExecutionHistoryPanelProps {
  executions: ExecutionRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const STATUS_TONE: Record<ExecutionStatus, Tone> = {
  pending_confirmation: "warning",
  running: "info",
  completed: "primary",
  rejected: "neutral",
  cancelled: "neutral",
  failed: "critical",
};

/** Matches the search query against the tool id, resolved command, and output — searching what a
 * command *did*, not just what it was named, is the point of the original design spec's Terminal
 * "Search" ask. */
function matchesQuery(execution: ExecutionRecord, query: string): boolean {
  if (!query) return true;
  const haystack = [execution.toolId, execution.resolvedCommand, execution.result?.stdout, execution.result?.stderr]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function HistoryRow({
  execution,
  bookmarked,
  onToggleBookmark,
}: {
  execution: ExecutionRecord;
  bookmarked: boolean;
  onToggleBookmark: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <GlassPanel padding="sm">
      <div className="flex items-center gap-2">
        {/* Not built on the shared Collapsible primitive - its trigger is a single button, and
         * the bookmark toggle below needs to be a sibling interactive element, not nested inside
         * one (invalid HTML, and would fire both handlers on one click). */}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={13}
            className={cn("shrink-0 text-muted transition-transform duration-200", expanded && "rotate-180")}
          />
          <StatusPill tone={STATUS_TONE[execution.status]} dot={false} className="shrink-0 px-1.5 py-0.5">
            {execution.status}
          </StatusPill>
          <span className="shrink-0 text-xs font-medium text-text">{execution.toolId}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
            {execution.resolvedCommand}
          </span>
          <span className="shrink-0 text-[11px] text-muted">{relativeTime(execution.createdAt)}</span>
        </button>
        <IconButton
          icon={bookmarked ? BookmarkCheck : Bookmark}
          label={bookmarked ? "Remove bookmark" : "Bookmark this execution"}
          size="sm"
          active={bookmarked}
          onClick={onToggleBookmark}
        />
      </div>

      {expanded && (
        <div className="mt-2">
          <ExecutionConsole
            toolId={execution.toolId}
            resolvedCommand={execution.resolvedCommand}
            status={execution.status}
            result={execution.result}
          />
        </div>
      )}
    </GlassPanel>
  );
}

/**
 * Search + bookmark across a project's tool execution history - the redesign's design spec asked
 * for this in the Terminal section but it was deliberately deferred at the time (see TODO.md) as
 * needing real state design. Search is a plain client-side filter over the executions this view
 * already has (no new backend endpoint - `GET /api/tools/executions` already returns full
 * stdout/stderr per record); bookmarks are frontend-only (hooks/useBookmarks.ts, localStorage),
 * since which executions matter to *you* is a personal preference, not project data.
 */
export function ExecutionHistoryPanel({ executions, loading, error, onRefresh }: ExecutionHistoryPanelProps) {
  const [query, setQuery] = useState("");
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const { isBookmarked, toggle } = useBookmarks();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return executions.filter((e) => (!bookmarkedOnly || isBookmarked(e.id)) && matchesQuery(e, q));
  }, [executions, query, bookmarkedOnly, isBookmarked]);

  return (
    <section>
      <SectionHeading
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh execution history"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className={loading ? "animate-spin" : undefined}
          />
        }
      >
        Execution History
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}

      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tool, command, or output…"
            className="w-full rounded-lg border border-border bg-surface-2 py-1.5 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </div>
        <IconButton
          icon={bookmarkedOnly ? BookmarkCheck : Bookmark}
          label={bookmarkedOnly ? "Showing bookmarked only — click to show all" : "Show bookmarked only"}
          size="sm"
          active={bookmarkedOnly}
          onClick={() => setBookmarkedOnly((b) => !b)}
        />
      </div>

      {!error && !loading && executions.length === 0 && <p className="text-xs text-muted">No executions yet</p>}
      {!error && executions.length > 0 && filtered.length === 0 && (
        <p className="text-xs text-muted">No executions match{bookmarkedOnly ? " your bookmarks" : ""}.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {filtered.map((execution) => (
          <HistoryRow
            key={execution.id}
            execution={execution}
            bookmarked={isBookmarked(execution.id)}
            onToggleBookmark={() => toggle(execution.id)}
          />
        ))}
      </div>
    </section>
  );
}
