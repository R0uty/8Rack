import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { ToolRegistry } from "./ToolRegistry";
import { ExecutionConsole } from "./ExecutionConsole";
import { useOrchestratorTask } from "../hooks/useOrchestratorTask";
import { useTools } from "../hooks/useTools";
import type { AgentWithStatus } from "../types/agent";
import type { OrchestratorMessage, TaskStatus } from "../types/orchestrator";

interface OrchestratorWorkbenchProps {
  agents: AgentWithStatus[];
  selectedAgentId: string | null;
}

const TERMINAL_STATUSES: TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "max_executions_reached",
  "max_time_reached",
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running…",
  waiting_confirmation: "Waiting for confirmation",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  max_executions_reached: "Stopped: max tool executions reached",
  max_time_reached: "Stopped: max task time reached",
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

function TaskMessageView({ message }: { message: OrchestratorMessage }) {
  if (message.role === "user") {
    return (
      <div className="workbench-message workbench-message--user">
        <div className="workbench-message__role">objective</div>
        <div className="workbench-message__body">{message.content}</div>
      </div>
    );
  }

  if (message.role === "tool") {
    let pretty = message.content;
    try {
      pretty = JSON.stringify(JSON.parse(message.content), null, 2);
    } catch {
      // Not JSON for some reason - show the raw content.
    }
    return (
      <div className="workbench-message workbench-message--tool">
        <div className="workbench-message__role">tool result</div>
        <pre className="workbench-message__tool-json">{pretty}</pre>
      </div>
    );
  }

  const toolRequest = tryParseToolRequestForDisplay(message.content);
  return (
    <div className="workbench-message workbench-message--assistant">
      <div className="workbench-message__role">assistant</div>
      {toolRequest ? (
        <div className="workbench-message__tool-call">
          called <code>{toolRequest.tool}</code>({JSON.stringify(toolRequest.arguments)})
        </div>
      ) : (
        <div className="workbench-message__body">
          <Markdown content={message.content} />
        </div>
      )}
    </div>
  );
}

export function OrchestratorWorkbench({ agents, selectedAgentId }: OrchestratorWorkbenchProps) {
  const { tools, executions, loading: toolsLoading, error: toolsError, refresh: refreshTools } = useTools();
  const { task, liveOutput, streamingText, busy, error, start, approve, reject, cancel, reset } =
    useOrchestratorTask();
  const [objective, setObjective] = useState("");

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  // Keyed on updatedAt, not just status: a rejected/invalid tool request gets retried internally
  // by the Orchestrator (see orchestrator.ts#advance's recursive call), so a task can land back on
  // "waiting_confirmation" with a *different* pendingExecutionId without the status string ever
  // changing — depending on status alone would miss refreshing `executions` for the new one.
  const taskUpdatedAt = task?.updatedAt;

  useEffect(() => {
    if (taskUpdatedAt) refreshTools();
  }, [taskUpdatedAt, refreshTools]);

  const handleStart = () => {
    if (!selectedAgentId || !objective.trim()) return;
    start(selectedAgentId, objective.trim());
    setObjective("");
  };

  const handleReset = () => {
    reset();
    setObjective("");
  };

  const pendingExecution = task?.pendingExecutionId
    ? executions.find((e) => e.id === task.pendingExecutionId)
    : undefined;

  return (
    <div className="workbench">
      <div className="workbench__main">
        {!task && (
          <div className="workbench__start">
            <h2 className="workbench__heading">New Task</h2>
            {!selectedAgentId && <p className="workbench__hint">Select an agent in the sidebar to start a task.</p>}
            <textarea
              className="workbench__objective"
              placeholder='Describe the objective for the agent, e.g. "List the workspace directory contents."'
              rows={4}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              disabled={!selectedAgentId || busy}
            />
            <button
              type="button"
              className="workbench__start-button"
              onClick={handleStart}
              disabled={!selectedAgentId || !objective.trim() || busy}
            >
              {busy ? "Starting…" : "Start Task"}
            </button>
            {error && <p className="workbench__error">{error}</p>}
            {busy && streamingText && (
              <div className="workbench__transcript">
                <div className="workbench-message workbench-message--assistant workbench-message--streaming">
                  <div className="workbench-message__role">assistant</div>
                  <div className="workbench-message__body">
                    <Markdown content={streamingText} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {task && (
          <div className="workbench__task">
            <div className="workbench__task-header">
              <span>Agent: {selectedAgent?.name ?? task.agentId}</span>
              <span className={`workbench__task-status workbench__task-status--${task.status}`}>
                {STATUS_LABEL[task.status]}
              </span>
              {!TERMINAL_STATUSES.includes(task.status) && (
                <button type="button" onClick={cancel} disabled={busy} className="workbench__cancel">
                  Cancel
                </button>
              )}
              {TERMINAL_STATUSES.includes(task.status) && (
                <button type="button" onClick={handleReset} className="workbench__new-task">
                  New Task
                </button>
              )}
            </div>

            <div className="workbench__transcript">
              {task.messages.map((m, i) => (
                <TaskMessageView key={i} message={m} />
              ))}
              {task.status === "running" && streamingText && (
                <div className="workbench-message workbench-message--assistant workbench-message--streaming">
                  <div className="workbench-message__role">assistant</div>
                  <div className="workbench-message__body">
                    <Markdown content={streamingText} />
                  </div>
                </div>
              )}
            </div>

            {task.status === "waiting_confirmation" && pendingExecution && (
              <div className="workbench__confirm">
                <ExecutionConsole
                  toolId={pendingExecution.toolId}
                  resolvedCommand={pendingExecution.resolvedCommand}
                  status={busy ? "running" : pendingExecution.status}
                  liveOutput={liveOutput}
                />
                <div className="workbench__confirm-actions">
                  <button type="button" onClick={approve} disabled={busy} className="workbench__approve">
                    {busy ? "Running…" : "Approve"}
                  </button>
                  <button type="button" onClick={reject} disabled={busy} className="workbench__reject">
                    Reject
                  </button>
                </div>
              </div>
            )}

            {task.error && <p className="workbench__error">{task.error}</p>}
            {error && <p className="workbench__error">{error}</p>}
          </div>
        )}
      </div>

      <aside className="workbench__sidebar">
        <ToolRegistry
          tools={tools}
          executions={executions}
          loading={toolsLoading}
          error={toolsError}
          onRefresh={refreshTools}
        />
      </aside>
    </div>
  );
}
