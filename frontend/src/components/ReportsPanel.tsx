import { useState } from "react";
import { Download, FileText, Trash2 } from "lucide-react";
import { Markdown } from "./Markdown";
import { Button, GlassPanel, IconButton, Sheet, Skeleton } from "./ui";
import { relativeTime } from "../lib/relativeTime";
import type { Report } from "../types/report";

interface ReportsPanelProps {
  reports: Report[];
  loading: boolean;
  error: string | null;
  onDelete: (id: string) => void;
}

function exportMarkdown(report: Report): void {
  const blob = new Blob([report.markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${report.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Report history for a project - list, full-document viewer, export, delete. Generation itself
 * happens from FindingsView's "Generate Report" bar (select findings in the Table view first);
 * this component is purely presentational, taking already-loaded state as props the same way
 * ToolRegistry/ExecutionHistoryPanel take `tools`/`executions` from OrchestratorWorkbench's single
 * owned `useTools()` call, rather than each fetching its own copy.
 */
export function ReportsPanel({ reports, loading, error, onDelete }: ReportsPanelProps) {
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (loading && reports.length === 0) return <Skeleton className="h-24 w-full" />;
  if (error) return <p className="text-xs text-critical">{error}</p>;
  if (reports.length === 0) {
    return (
      <p className="text-xs text-muted">
        No reports yet - select findings in the Table view and click "Generate Report".
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {reports.map((r) => (
          <GlassPanel key={r.id} padding="md" className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => setOpenReport(r)} className="min-w-0 flex-1 text-left">
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <FileText size={13} className="shrink-0 text-muted" />
                <span className="truncate">{r.title}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {r.findingIds.length} finding{r.findingIds.length === 1 ? "" : "s"} · {relativeTime(r.createdAt)}
              </p>
            </button>
            {confirmDeleteId === r.id ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    onDelete(r.id);
                    setConfirmDeleteId(null);
                  }}
                >
                  Delete
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteId(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton icon={Download} label="Export as Markdown" size="sm" onClick={() => exportMarkdown(r)} />
                <IconButton icon={Trash2} label="Delete report" size="sm" onClick={() => setConfirmDeleteId(r.id)} />
              </div>
            )}
          </GlassPanel>
        ))}
      </div>

      <Sheet
        open={openReport !== null}
        onClose={() => setOpenReport(null)}
        title={openReport?.title ?? "Report"}
        width="max-w-3xl"
      >
        {openReport && (
          <>
            <p className="mb-4 text-xs text-muted">
              Generated {relativeTime(openReport.createdAt)} by {openReport.agentId} ({openReport.model}) from{" "}
              {openReport.findingIds.length} finding{openReport.findingIds.length === 1 ? "" : "s"}.
            </p>
            <Markdown content={openReport.markdown} />
            <div className="mt-4">
              <Button variant="secondary" size="sm" icon={Download} onClick={() => exportMarkdown(openReport)}>
                Export as Markdown
              </Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
