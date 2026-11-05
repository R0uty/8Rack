import { Database, RefreshCw } from "lucide-react";
import { useRag } from "../hooks/useRag";
import { Button, GlassPanel, SectionHeading, Skeleton } from "./ui";
import { relativeTime } from "../lib/relativeTime";

/**
 * Status + reindex control for the RAG knowledge base (see backend/src/services/ragIndex.ts) —
 * a global index over env.workspaceRoot, not mission-scoped, so this is a workspace-level setup
 * concern on the Tools page rather than inside any one mission's UI.
 */
export function KnowledgeBasePanel() {
  const { status, loading, reindexing, error, reindex } = useRag();

  return (
    <section>
      <SectionHeading
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            iconClassName={reindexing ? "animate-spin" : undefined}
            onClick={reindex}
            disabled={reindexing}
          >
            {reindexing ? "Indexing…" : "Reindex"}
          </Button>
        }
      >
        Knowledge Base
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}

      {loading && !status && <Skeleton className="h-16 w-full" />}

      {status && (
        <GlassPanel padding="md">
          <div className="flex items-center gap-2 text-sm text-text">
            <Database size={14} className="text-muted" />
            {status.indexedAt
              ? `${status.chunkCount} chunk${status.chunkCount === 1 ? "" : "s"} across ${status.fileCount} file${status.fileCount === 1 ? "" : "s"}`
              : "Not indexed yet"}
          </div>
          <p className="mt-2 truncate font-mono text-[11px] text-muted" title={status.workspaceRoot}>
            {status.workspaceRoot}
          </p>
          <p className="mt-1 text-xs text-muted">
            {status.indexedAt ? `Indexed ${relativeTime(status.indexedAt)} · ` : ""}
            embedding model <span className="font-mono">{status.embeddingModel}</span>
          </p>
          {reindexing && (
            <p className="mt-2 text-xs text-info">
              Walking and embedding the workspace — this can take a while for a large folder.
            </p>
          )}
        </GlassPanel>
      )}
    </section>
  );
}
