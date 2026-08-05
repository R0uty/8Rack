import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { ToolRegistry } from "./ToolRegistry";
import { ProjectPanel } from "./ProjectPanel";
import { OrchestratorTaskView, TERMINAL_STATUSES } from "./OrchestratorTaskView";
import { Button, GlassPanel, StreamingCursor } from "./ui";
import { useOrchestratorTask } from "../hooks/useOrchestratorTask";
import { useTools } from "../hooks/useTools";
import { useProjects } from "../hooks/useProjects";
import type { AgentWithStatus } from "../types/agent";
import type { Project } from "../types/project";

interface OrchestratorWorkbenchProps {
  agents: AgentWithStatus[];
  selectedAgentId: string | null;
}

export function OrchestratorWorkbench({ agents, selectedAgentId }: OrchestratorWorkbenchProps) {
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
    create: createProject,
    remove: removeProject,
  } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { tools, executions, loading: toolsLoading, error: toolsError, refresh: refreshTools } =
    useTools(selectedProjectId);
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

  // If the selected project was just deleted (e.g. from another tab, or a stale delete retried),
  // fall back to no selection rather than continuing to operate against a project that's gone.
  useEffect(() => {
    if (selectedProjectId && !projectsLoading && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, projectsLoading, selectedProjectId]);

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId((current) => (current === project.id ? null : project.id));
  };

  const handleStart = () => {
    if (!selectedAgentId || !selectedProjectId || !objective.trim()) return;
    start(selectedAgentId, objective.trim(), selectedProjectId);
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
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
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
          disabled={!!task && !TERMINAL_STATUSES.includes(task.status)}
        />

        {!task && (
          <GlassPanel padding="lg" className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-text">New Task</h2>
            {!selectedAgentId && !selectedProjectId && (
              <p className="text-xs text-muted">Select an agent in the sidebar and a project above to start a task.</p>
            )}
            {!selectedAgentId && selectedProjectId && (
              <p className="text-xs text-muted">Select an agent in the sidebar to start a task.</p>
            )}
            {selectedAgentId && !selectedProjectId && (
              <p className="text-xs text-muted">Select or create a project above to start a task.</p>
            )}
            <textarea
              placeholder='Describe the objective for the agent, e.g. "List the workspace directory contents."'
              rows={4}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              disabled={!selectedAgentId || !selectedProjectId || busy}
              className="resize-none rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 disabled:opacity-50"
            />
            <Button
              variant="primary"
              onClick={handleStart}
              disabled={!selectedAgentId || !selectedProjectId || !objective.trim() || busy}
              className="self-start"
            >
              {busy ? "Starting…" : "Start Task"}
            </Button>
            {error && <p className="text-xs text-critical">{error}</p>}
            {busy && streamingText && (
              <GlassPanel padding="md" raised className="border-primary/15">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">assistant</div>
                <Markdown content={streamingText} />
                <StreamingCursor />
              </GlassPanel>
            )}
          </GlassPanel>
        )}

        {task && (
          <OrchestratorTaskView
            task={task}
            headerLabel={`Agent: ${selectedAgent?.name ?? task.agentId}`}
            pendingExecution={pendingExecution}
            liveOutput={liveOutput}
            streamingText={streamingText}
            busy={busy}
            error={error}
            onApprove={approve}
            onReject={reject}
            onCancel={cancel}
            onReset={handleReset}
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
        />
      </aside>
    </div>
  );
}
