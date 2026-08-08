import { useEffect, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { ToolRegistry } from "./ToolRegistry";
import { ProjectPanel } from "./ProjectPanel";
import { KnowledgeBasePanel } from "./KnowledgeBasePanel";
import { ScannerPanel } from "./ScannerPanel";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { TaskSessionPanel } from "./workbench/TaskSessionPanel";
import { SessionTabs } from "./layout";
import { Button, GlassPanel } from "./ui";
import { useTools } from "../hooks/useTools";
import { useProjects } from "../hooks/useProjects";
import { cn } from "../lib/cn";
import type { AgentWithStatus } from "../types/agent";
import type { OllamaModel } from "../types/ollama";
import type { Project } from "../types/project";
import type { UseSessions } from "../hooks/useSessions";

interface OrchestratorWorkbenchProps {
  agents: AgentWithStatus[];
  models: OllamaModel[];
  sessions: UseSessions;
}

function agentName(agents: AgentWithStatus[], agentId: string | null): string {
  return agents.find((a) => a.id === agentId)?.name ?? agentId ?? "";
}

/** The Workbench nav view: a tab strip of open task sessions (see hooks/useSessions.ts) plus a
 * permanent Home tab for picking a project and starting a new one. Project selection and the tool
 * registry stay view-wide (project-scoped, not session-scoped) rather than living per tab. */
export function OrchestratorWorkbench({ agents, models, sessions }: OrchestratorWorkbenchProps) {
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
    create: createProject,
    update: updateProject,
    remove: removeProject,
  } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { tools, executions, loading: toolsLoading, error: toolsError, refresh: refreshTools, toggleTool } =
    useTools(selectedProjectId);

  const {
    taskSessions,
    activeTaskId,
    statuses,
    openTaskSession,
    closeSession,
    setActiveTask,
    markTaskStarted,
    reportStatus,
  } = sessions;

  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  const [objective, setObjective] = useState("");

  useEffect(() => {
    if (selectedProjectId && !projectsLoading && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, projectsLoading, selectedProjectId]);

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId((current) => (current === project.id ? null : project.id));
  };

  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;

  const handleSelectAgent = (id: string) => {
    setAgentId(id);
    // Seed the model to this agent's default — still overridable via the select below, same
    // per-session-override convention as chat (see chatService.ts#AgentChatRequest.model).
    const agent = agents.find((a) => a.id === id);
    setModel(agent?.model ?? "");
  };

  const handleStart = () => {
    if (!selectedAgent || !selectedProjectId || !objective.trim()) return;
    openTaskSession(selectedAgent.id, model || selectedAgent.model, selectedProjectId, objective.trim());
    setObjective("");
    setAgentId("");
    setModel("");
  };

  return (
    <div className="flex h-full flex-col">
      <SessionTabs
        sessions={taskSessions}
        activeId={activeTaskId}
        onSelect={setActiveTask}
        onClose={closeSession}
        agents={agents}
        statuses={statuses}
        homeIcon={LayoutGrid}
        homeLabel="New Task"
      />

      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        <div className={cn(activeTaskId !== null && "hidden")}>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-4">
              <KnowledgeBasePanel />

              <ProjectPanel
                projects={projects}
                loading={projectsLoading}
                error={projectsError}
                selectedProjectId={selectedProjectId}
                onSelect={handleSelectProject}
                onCreate={createProject}
                onUpdate={updateProject}
                onDelete={removeProject}
                onRefresh={refreshProjects}
              />

              <ScannerPanel projectId={selectedProjectId} />

              <GlassPanel padding="lg" className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-text">New Task</h2>
                {!selectedProjectId && <p className="text-xs text-muted">Select or create a project above to start a task.</p>}
                <div className="flex gap-2">
                  <select
                    value={agentId}
                    onChange={(e) => handleSelectAgent(e.target.value)}
                    className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <option value="">Select agent…</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {agentId && (
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      title="Model for this task — defaults to the agent's own, overridable"
                      className="w-44 rounded-lg border border-border bg-surface-2 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <textarea
                  placeholder='Describe the objective for the agent, e.g. "List the workspace directory contents."'
                  rows={4}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  disabled={!agentId || !selectedProjectId}
                  className="resize-none rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
                />
                <Button
                  variant="primary"
                  onClick={handleStart}
                  disabled={!agentId || !selectedProjectId || !objective.trim()}
                  className="self-start"
                >
                  Start Task
                </Button>
              </GlassPanel>
            </div>

            <aside className="flex flex-col gap-4">
              <ToolRegistry
                tools={tools}
                executions={executions}
                loading={toolsLoading}
                error={toolsError}
                onRefresh={refreshTools}
                onToggleEnabled={toggleTool}
              />
              <ExecutionHistoryPanel
                executions={executions}
                loading={toolsLoading}
                error={toolsError}
                onRefresh={refreshTools}
                agents={agents}
              />
            </aside>
          </div>
        </div>

        {taskSessions.map((session) => (
          <div key={session.id} className={cn(session.id !== activeTaskId && "hidden")}>
            <TaskSessionPanel
              session={session}
              agentName={agentName(agents, session.agentId)}
              reportStatus={reportStatus}
              markStarted={markTaskStarted}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
