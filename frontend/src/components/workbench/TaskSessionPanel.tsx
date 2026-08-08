import { useEffect, useRef } from "react";
import { useOrchestratorTask } from "../../hooks/useOrchestratorTask";
import { useTools } from "../../hooks/useTools";
import type { SessionMeta } from "../../hooks/useSessions";
import { OrchestratorTaskView, STATUS_TONE } from "../OrchestratorTaskView";
import { ToolRegistry } from "../ToolRegistry";
import { GlassPanel, StreamingCursor, type Tone } from "../ui";
import { Markdown } from "../Markdown";

interface TaskSessionPanelProps {
  session: SessionMeta;
  agentName: string;
  reportStatus: (id: string, tone: Tone) => void;
  markStarted: (id: string) => void;
}

/**
 * One Workbench task - a thin wrapper around the existing OrchestratorTaskView, parameterized by
 * a session's own agent/model/project instead of a single global selection. Mounted once per open
 * task session (see hooks/useSessions.ts) and kept mounted while inactive, so a task keeps running
 * and streaming in the background while another session tab is focused.
 */
export function TaskSessionPanel({ session, agentName, reportStatus, markStarted }: TaskSessionPanelProps) {
  const { task, liveOutput, streamingText, busy, error, start, approve, reject, continueTask, provideGuidance, cancel } =
    useOrchestratorTask();
  const { tools, executions, loading: toolsLoading, error: toolsError, refresh: refreshTools, toggleTool } = useTools(
    session.projectId ?? null,
  );
  // Guards the auto-start effect within this mount's lifetime (StrictMode double-invokes effects
  // synchronously, before session.started's persisted flip would be visible yet).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || session.started) return;
    if (!session.agentId || !session.projectId || !session.initialObjective) return;
    startedRef.current = true;
    markStarted(session.id);
    void start(session.agentId, session.initialObjective, session.projectId, session.model);
    // Only ever meant to fire once, right after this session was created by the New Task form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskUpdatedAt = task?.updatedAt;
  useEffect(() => {
    if (taskUpdatedAt) refreshTools();
  }, [taskUpdatedAt, refreshTools]);

  useEffect(() => {
    if (task) reportStatus(session.id, STATUS_TONE[task.status]);
  }, [task, session.id, reportStatus]);

  const pendingExecution = task?.pendingExecutionId
    ? executions.find((e) => e.id === task.pendingExecutionId)
    : undefined;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
      <div>
        {!task ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">Starting…</p>
            {busy && streamingText && (
              <GlassPanel padding="md" className="border-primary/15">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">assistant</div>
                <Markdown content={streamingText} />
                <StreamingCursor />
              </GlassPanel>
            )}
            {error && <p className="text-xs text-critical">{error}</p>}
          </div>
        ) : (
          <OrchestratorTaskView
            task={task}
            headerLabel={`Agent: ${agentName}`}
            pendingExecution={pendingExecution}
            liveOutput={liveOutput}
            streamingText={streamingText}
            busy={busy}
            error={error}
            onApprove={approve}
            onReject={reject}
            onProvideGuidance={provideGuidance}
            onContinue={continueTask}
            onCancel={cancel}
          />
        )}
      </div>

      <aside>
        <ToolRegistry
          tools={tools}
          executions={executions}
          loading={toolsLoading}
          error={toolsError}
          onRefresh={refreshTools}
          onToggleEnabled={toggleTool}
        />
      </aside>
    </div>
  );
}
