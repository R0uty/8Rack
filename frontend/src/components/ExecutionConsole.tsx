import { useState } from "react";
import { AlertTriangle, Check, Copy, Download, Terminal } from "lucide-react";
import type { ExecutionResult, ExecutionStatus } from "../types/execTool";
import type { LiveOutputChunk } from "../hooks/useOrchestratorTask";
import { GlassPanel, IconButton, ProgressRing, StatusPill, type Tone } from "./ui";
import { cn } from "../lib/cn";

interface ExecutionConsoleProps {
  toolId: string;
  resolvedCommand: string;
  status: ExecutionStatus;
  result?: ExecutionResult;
  /** Chunks received so far, in order — used while the execution is still streaming (no result yet). */
  liveOutput?: LiveOutputChunk[];
  /** Set when the mission has scope configured but no target could be identified in this
   * execution's arguments - see ExecutionRecord.scopeWarning. A clear scope violation is blocked
   * outright before an execution ever reaches this console, so this is the only scope-related
   * signal a human reviewing a pending confirmation ever sees here. */
  scopeWarning?: string;
}

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending_confirmation: "Awaiting confirmation",
  running: "Running…",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STATUS_TONE: Record<ExecutionStatus, Tone> = {
  pending_confirmation: "warning",
  running: "info",
  completed: "primary",
  rejected: "neutral",
  cancelled: "neutral",
  failed: "critical",
};

export function ExecutionConsole({
  toolId,
  resolvedCommand,
  status,
  result,
  liveOutput,
  scopeWarning,
}: ExecutionConsoleProps) {
  const [copied, setCopied] = useState(false);

  const outputText = liveOutput?.length
    ? liveOutput.map((c) => c.data).join("")
    : [result?.stdout, result?.stderr].filter(Boolean).join("\n");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(outputText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = () => {
    const blob = new Blob([`$ ${resolvedCommand}\n\n${outputText}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${toolId}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <GlassPanel padding="none" className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2 font-mono text-xs font-medium text-text">
          <Terminal size={13} className="text-muted" />
          {toolId}
        </div>
        <div className="flex items-center gap-1.5">
          <StatusPill tone={STATUS_TONE[status]} pulse={status === "running"} dot={status !== "running"}>
            {status === "running" && <ProgressRing size={11} />}
            {STATUS_LABEL[status]}
          </StatusPill>
        </div>
      </div>

      <pre className="overflow-x-auto px-3.5 py-2.5 font-mono text-xs text-info">$ {resolvedCommand}</pre>

      {scopeWarning && (
        <div className="flex items-start gap-2 border-t border-border bg-warning-dim px-3.5 py-2.5 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{scopeWarning}</span>
        </div>
      )}

      {(!!liveOutput?.length || (result && (result.stdout || result.stderr))) && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border bg-black/20 px-3.5 py-3 font-mono text-xs">
          {liveOutput && liveOutput.length > 0
            ? liveOutput.map((chunk, i) => (
                <span key={i} className={chunk.stream === "stderr" ? "text-critical" : "text-text"}>
                  {chunk.data}
                </span>
              ))
            : (
                <>
                  {result?.stdout && <span className="text-text">{result.stdout}</span>}
                  {result?.stderr && <span className="text-critical">{result.stderr}</span>}
                </>
              )}
        </pre>
      )}

      {result && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5 text-xs">
          <span
            className={cn(
              "rounded-pill px-2 py-0.5 text-[11px] font-medium",
              result.success ? "bg-primary-dim text-primary" : "bg-critical-dim text-critical",
            )}
          >
            {result.success ? "Success" : "Failure"}
          </span>
          <span className="text-muted">exit {result.exitCode ?? "—"}</span>
          <span className="text-muted">{result.executionTimeMs}ms</span>
          {result.timedOut && <span className="text-warning">timed out</span>}
          {result.cancelled && <span className="text-muted">cancelled</span>}
          {result.truncated && <span className="text-muted">output truncated</span>}

          {outputText && (
            <div className="ml-auto flex items-center gap-1">
              <IconButton icon={copied ? Check : Copy} label="Copy output" size="sm" onClick={handleCopy} />
              <IconButton icon={Download} label="Export output" size="sm" onClick={handleExport} />
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
