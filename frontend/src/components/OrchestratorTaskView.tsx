import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowUp, Wrench } from "lucide-react";
import { Markdown } from "./Markdown";
import { ExecutionConsole } from "./ExecutionConsole";
import { Button, Collapsible, GlassPanel, IconButton, StatusPill, StreamingCursor, type Tone } from "./ui";
import type { LiveOutputChunk } from "../hooks/useOrchestratorTask";
import type { ExecutionRecord } from "../types/execTool";
import type { OrchestratorMessage, OrchestratorTask, TaskStatus } from "../types/orchestrator";

/**
 * Renders a single Orchestrator task end to end: status header, message transcript (with the
 * live-streaming bubble while a reply is still coming in), and the Approve/Reject confirm card
 * while waiting on a tool. Shared by the single-agent Workbench and the multi-agent Planner's
 * "current step" view — both drive a live OrchestratorTask through the same confirm/resume flow,
 * so this is real reuse, not premature abstraction.
 */

export const TERMINAL_STATUSES: TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "max_executions_reached",
  "max_time_reached",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running…",
  waiting_confirmation: "Waiting for confirmation",
  waiting_guidance: "Needs your input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  max_executions_reached: "Stopped: max tool executions reached",
  max_time_reached: "Stopped: max task time reached",
};

export const STATUS_TONE: Record<TaskStatus, Tone> = {
  running: "info",
  waiting_confirmation: "warning",
  waiting_guidance: "critical",
  completed: "primary",
  failed: "critical",
  cancelled: "neutral",
  max_executions_reached: "warning",
  max_time_reached: "warning",
};

/** Best-effort detection of a tool-request JSON in an assistant message, for nicer display only —
 * mirrors backend/src/services/orchestrator.ts#parseToolRequest's shape check. */
function tryParseToolRequestForDisplay(content: string): { tool: string; arguments: string[] } | undefined {
  let candidate = content.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidate = fence[1].trim();
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; arguments?: unknown };
    if (typeof parsed.tool === "string" && Array.isArray(parsed.arguments)) {
      return { tool: parsed.tool, arguments: parsed.arguments as string[] };
    }
  } catch {
    // Not a tool request - render as plain text/markdown below.
  }
  return undefined;
}

interface ToolResultContent {
  rejected?: boolean;
  message?: string;
  tool?: string;
  status?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  parsedOutput?: unknown;
}

/** Renders a tool's parsedOutput (or stdout, when the tool has no parser) as plain readable text —
 * an array of strings (the "lines" parser) reads better one-per-line than as JSON syntax. */
function formatNormalResult(parsed: ToolResultContent): string {
  const { parsedOutput } = parsed;
  if (Array.isArray(parsedOutput)) {
    return parsedOutput.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n") || "(no output)";
  }
  if (typeof parsedOutput === "string") return parsedOutput || "(no output)";
  if (parsedOutput !== undefined) return JSON.stringify(parsedOutput, null, 2);
  return parsed.stdout?.trim() || "(no output)";
}

/** Above this many characters, a tool result collapses behind a toggle by default - some tools
 * (nmap, ffuf, a big directory listing, ...) can produce output long enough to dominate the whole
 * transcript otherwise. */
const TOOL_RESULT_COLLAPSE_THRESHOLD = 400;
const PREVIEW_LENGTH = 160;

function previewOf(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const truncated = firstLine.length > PREVIEW_LENGTH || text.length > firstLine.length;
  const base = firstLine.length > PREVIEW_LENGTH ? firstLine.slice(0, PREVIEW_LENGTH) : firstLine;
  return truncated ? `${base}…` : base;
}

function RoleLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</div>;
}

function UserCard({ message }: { message: OrchestratorMessage }) {
  return (
    <GlassPanel padding="md">
      <RoleLabel>objective</RoleLabel>
      <p className="text-sm text-text">{message.content}</p>
    </GlassPanel>
  );
}

function AssistantCard({ message }: { message: OrchestratorMessage }) {
  const toolRequest = tryParseToolRequestForDisplay(message.content);
  return (
    <GlassPanel padding="md" className="border-primary/15">
      <RoleLabel>assistant</RoleLabel>
      {toolRequest ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-warning/25 bg-warning-dim px-3 py-2 font-mono text-xs text-warning">
          <Wrench size={12} />
          {toolRequest.tool}({JSON.stringify(toolRequest.arguments)})
        </div>
      ) : (
        <Markdown content={message.content} />
      )}
    </GlassPanel>
  );
}

function ToolResultCard({ message }: { message: OrchestratorMessage }) {
  let parsed: ToolResultContent | undefined;
  try {
    parsed = JSON.parse(message.content) as ToolResultContent;
  } catch {
    // Not valid JSON - fall through to the single-block raw rendering below.
  }

  const normalText = parsed && !parsed.rejected ? formatNormalResult(parsed) : "";
  const rawText = parsed ? JSON.stringify(parsed, null, 2) : "";
  const isLong = normalText.length > TOOL_RESULT_COLLAPSE_THRESHOLD || rawText.length > TOOL_RESULT_COLLAPSE_THRESHOLD;

  if (!parsed || parsed.rejected) {
    return (
      <GlassPanel padding="md">
        <RoleLabel>tool result</RoleLabel>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted">
          {parsed ? JSON.stringify(parsed, null, 2) : message.content}
        </pre>
      </GlassPanel>
    );
  }

  const body = (
    <div className="space-y-2.5">
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Result</div>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/20 px-3 py-2 font-mono text-xs text-text">
          {normalText}
        </pre>
      </div>
      {parsed.stderr && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">stderr</div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/20 px-3 py-2 font-mono text-xs text-critical">
            {parsed.stderr}
          </pre>
        </div>
      )}
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Raw</div>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/20 px-3 py-2 font-mono text-xs text-muted">
          {rawText}
        </pre>
      </div>
    </div>
  );

  return (
    <GlassPanel padding="md">
      {isLong ? (
        <Collapsible
          defaultOpen={false}
          trigger={
            <div>
              <RoleLabel>
                tool result — {parsed.tool} ({parsed.status})
              </RoleLabel>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted">{previewOf(normalText)}</pre>
            </div>
          }
        >
          {body}
        </Collapsible>
      ) : (
        <>
          <RoleLabel>
            tool result — {parsed.tool} ({parsed.status})
          </RoleLabel>
          {body}
        </>
      )}
    </GlassPanel>
  );
}

function TaskMessageView({ message }: { message: OrchestratorMessage }) {
  if (message.role === "user") return <UserCard message={message} />;
  if (message.role === "tool") return <ToolResultCard message={message} />;
  return <AssistantCard message={message} />;
}

/** A follow-up message box shown once a task has completed - sends more instructions into the
 * same task (same message history, same tool budget already spent) instead of forcing a brand
 * new task with no memory of what came before. Mirrors PromptInput's Enter-to-send convention. */
function ContinueTaskInput({ busy, onContinue }: { busy: boolean; onContinue: (message: string) => void }) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onContinue(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <GlassPanel padding="none" className="flex items-end gap-2 p-2.5" raised>
      <textarea
        className="max-h-[160px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text placeholder:text-muted focus:outline-none disabled:opacity-50"
        placeholder="Send a follow-up to continue this task…"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={busy}
      />
      <IconButton
        icon={ArrowUp}
        label="Continue task"
        variant="primary"
        onClick={submit}
        disabled={busy || !value.trim()}
      />
    </GlassPanel>
  );
}

/** Shown when a task pauses at "waiting_guidance" - a tool request that failed outright (no
 * pendingExecution to show), or a confirmed execution that ran and failed/was cancelled (rendered
 * above via the existing ExecutionConsole). Lets a human add a correction before the agent tries
 * again - e.g. "that tool isn't installed, try httpx instead" - but the box is optional: hitting
 * Continue empty just lets the agent retry on its own with whatever's already in the transcript. */
function GuidanceInput({ busy, onProvideGuidance }: { busy: boolean; onProvideGuidance: (note: string) => void }) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (busy) return;
    onProvideGuidance(value.trim());
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-1.5 text-xs text-warning">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        That didn't go as planned. Optionally tell the agent what to do differently, or just hit Continue to let it try again on its own.
      </div>
      <GlassPanel padding="none" className="flex items-end gap-2 p-2.5" raised>
        <textarea
          className="max-h-[160px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text placeholder:text-muted focus:outline-none disabled:opacity-50"
          placeholder={'Optional: e.g. "that tool isn\'t installed, try httpx instead"…'}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />
        <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? "Continuing…" : "Continue"}
        </Button>
      </GlassPanel>
    </div>
  );
}

interface OrchestratorTaskViewProps {
  task: OrchestratorTask;
  /** Fully-formed header text, e.g. "Agent: Recon Agent" or "Step 2 — Recon Agent". */
  headerLabel: string;
  pendingExecution?: ExecutionRecord;
  liveOutput: LiveOutputChunk[];
  streamingText: string;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  /** Called from the waiting_guidance card (a failed tool request/execution) with an optional
   * correction/suggestion - empty string means "just try again". */
  onProvideGuidance: (note: string) => void;
  /** Omit to hide the follow-up input entirely (e.g. the Planner's per-step view, where a step's
   * task is one leg of a fixed plan rather than something to keep talking to on its own). */
  onContinue?: (message: string) => void;
  /** Omit to hide the Cancel button entirely (e.g. when the caller renders its own). */
  onCancel?: () => void;
  /** Omit to hide the "New Task" button (e.g. the Planner shows its own "New Plan" outside). */
  onReset?: () => void;
}

export function OrchestratorTaskView({
  task,
  headerLabel,
  pendingExecution,
  liveOutput,
  streamingText,
  busy,
  error,
  onApprove,
  onReject,
  onProvideGuidance,
  onContinue,
  onCancel,
  onReset,
}: OrchestratorTaskViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-sm font-medium text-text">{headerLabel}</span>
        <StatusPill tone={STATUS_TONE[task.status]} pulse={task.status === "running"}>
          {STATUS_LABEL[task.status]}
        </StatusPill>
        {onCancel && !TERMINAL_STATUSES.includes(task.status) && (
          <Button variant="danger" size="sm" onClick={onCancel} disabled={busy} className="ml-auto">
            Cancel
          </Button>
        )}
        {onReset && TERMINAL_STATUSES.includes(task.status) && (
          <Button variant="secondary" size="sm" onClick={onReset} className="ml-auto">
            New Task
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {task.messages.map((m, i) => (
          <TaskMessageView key={i} message={m} />
        ))}
        {task.status === "running" && streamingText && (
          <GlassPanel padding="md" className="border-primary/15">
            <RoleLabel>assistant</RoleLabel>
            <Markdown content={streamingText} />
            <StreamingCursor />
          </GlassPanel>
        )}
      </div>

      {task.status === "waiting_confirmation" && pendingExecution && (
        <div className="flex flex-col gap-2.5">
          <ExecutionConsole
            toolId={pendingExecution.toolId}
            resolvedCommand={pendingExecution.resolvedCommand}
            status={busy ? "running" : pendingExecution.status}
            liveOutput={liveOutput}
            scopeWarning={pendingExecution.scopeWarning}
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={onApprove} disabled={busy}>
              {busy ? "Running…" : "Approve"}
            </Button>
            <Button variant="danger" onClick={onReject} disabled={busy}>
              Reject
            </Button>
          </div>
        </div>
      )}

      {task.status === "waiting_guidance" && (
        <div className="flex flex-col gap-2.5">
          {pendingExecution && (
            <ExecutionConsole
              toolId={pendingExecution.toolId}
              resolvedCommand={pendingExecution.resolvedCommand}
              status={pendingExecution.status}
              result={pendingExecution.result}
            />
          )}
          <GuidanceInput busy={busy} onProvideGuidance={onProvideGuidance} />
        </div>
      )}

      {onContinue && task.status === "completed" && <ContinueTaskInput busy={busy} onContinue={onContinue} />}

      {task.error && <p className="text-xs text-critical">{task.error}</p>}
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}
