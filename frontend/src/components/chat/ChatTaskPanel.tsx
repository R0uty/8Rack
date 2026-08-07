import { useEffect, useRef, useState } from "react";
import { useOrchestratorTask } from "../../hooks/useOrchestratorTask";
import { useTools } from "../../hooks/useTools";
import type { SessionMeta } from "../../hooks/useSessions";
import { OrchestratorTaskView, STATUS_TONE } from "../OrchestratorTaskView";
import { PromptInput } from "../PromptInput";
import { GlassPanel, StreamingCursor, type Tone } from "../ui";
import { Markdown } from "../Markdown";

interface ChatTaskPanelProps {
  session: SessionMeta;
  agentName: string;
  reportStatus: (id: string, tone: Tone) => void;
  /** Records the backend task id onto the session once one exists, so a later reload can restore
   * it - see hooks/useSessions.ts#SessionMeta.taskId. */
  onChangeTaskId: (sessionId: string, taskId: string) => void;
}

/**
 * The tool-enabled counterpart to the plain-streaming chat body (see ChatSessionPanel.tsx) -
 * mounted instead of it once a project is picked for the session. Unlike
 * workbench/TaskSessionPanel.tsx, there's no upfront objective collected before this mounts - the
 * first message the user sends here *is* the objective that starts the OrchestratorTask.
 */
export function ChatTaskPanel({ session, agentName, reportStatus, onChangeTaskId }: ChatTaskPanelProps) {
  const { task, liveOutput, streamingText, busy, error, start, approve, reject, continueTask, provideGuidance, cancel, restore, reset } =
    useOrchestratorTask();
  const { executions, refresh: refreshTools } = useTools(session.projectId ?? null);
  const [prompt, setPrompt] = useState("");

  // useOrchestratorTask's state is plain React state with no persistence (unlike useChat.ts's
  // sessionStorage-backed messages) - a reload wipes it even though session.taskId (sessionStorage)
  // and the backend task itself both survive. Refetch it once, right after this panel (re)mounts.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !session.taskId) return;
    restoredRef.current = true;
    void restore(session.taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (task && task.id !== session.taskId) onChangeTaskId(session.id, task.id);
  }, [task, session.id, session.taskId, onChangeTaskId]);

  const taskUpdatedAt = task?.updatedAt;
  useEffect(() => {
    if (taskUpdatedAt) refreshTools();
  }, [taskUpdatedAt, refreshTools]);

  useEffect(() => {
    reportStatus(session.id, task ? STATUS_TONE[task.status] : busy ? "info" : "neutral");
  }, [task, busy, session.id, reportStatus]);

  const pendingExecution = task?.pendingExecutionId ? executions.find((e) => e.id === task.pendingExecutionId) : undefined;

  const handleSubmit = () => {
    if (!session.agentId || !session.projectId) return;
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    void start(session.agentId, trimmed, session.projectId, session.model);
    setPrompt("");
  };

  if (!task) {
    // session.taskId set but no task loaded yet means a restore() is in flight (or about to be) -
    // this isn't actually a blank chat, so say so rather than showing the "say something" prompt.
    const restoring = Boolean(session.taskId) && busy;
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
          <p className="text-sm text-muted">
            {restoring ? "Loading conversation…" : "No messages yet — say something below."}
          </p>
          {!restoring && (
            <p className="text-xs text-muted">
              Tools are enabled for this chat — {agentName} can request to run commands, with your approval.
            </p>
          )}
          {busy && streamingText && (
            <GlassPanel padding="md" className="mt-3 w-full border-primary/15 text-left">
              <Markdown content={streamingText} />
              <StreamingCursor />
            </GlassPanel>
          )}
          {error && <p className="text-xs text-critical">{error}</p>}
        </div>
        <PromptInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleSubmit}
          onCancel={cancel}
          sending={busy}
          disabled={!session.agentId || !session.projectId}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pb-2">
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
        onReset={reset}
      />
    </div>
  );
}
