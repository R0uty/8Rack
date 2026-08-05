import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { ToolRegistry } from "./ToolRegistry";
import { ProjectPanel } from "./ProjectPanel";
import { OrchestratorTaskView, STATUS_TONE } from "./OrchestratorTaskView";
import { Button, Collapsible, GlassPanel, StatusPill, StreamingCursor } from "./ui";
import { useMultiAgentPlan } from "../hooks/useMultiAgentPlan";
import { useProjects } from "../hooks/useProjects";
import { useTools } from "../hooks/useTools";
import { cn } from "../lib/cn";
import type { AgentWithStatus } from "../types/agent";
import type { Project } from "../types/project";
import type { MultiAgentPlanStatus, PlanStep, PlanStepRun } from "../types/multiAgentPlan";

interface MultiAgentPlannerProps {
  agents: AgentWithStatus[];
}

const MIN_STEPS = 2;
const PLAN_TERMINAL_STATUSES: MultiAgentPlanStatus[] = ["completed", "failed", "cancelled"];

function emptyStep(): PlanStep {
  return { agentId: "", objective: "" };
}

function agentName(agents: AgentWithStatus[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

/** Numbered connector rail on the left + card content on the right - gives the sequential plan
 * its "workflow" feel using only real step data (no fabricated progress numbers). */
function StepRow({
  index,
  isLast,
  tone,
  children,
}: {
  index: number;
  isLast: boolean;
  tone: "primary" | "info" | "muted";
  children: ReactNode;
}) {
  const dotClass =
    tone === "primary" ? "border-primary bg-primary-dim text-primary" : tone === "info" ? "border-info bg-info-dim text-info" : "border-border bg-card text-muted";
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", dotClass)}>
          {index + 1}
        </div>
        {!isLast && <div className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  );
}

function CompletedStepCard({ run, agents }: { run: PlanStepRun; agents: AgentWithStatus[] }) {
  return (
    <GlassPanel padding="md">
      <Collapsible
        defaultOpen={false}
        trigger={
          <div className="flex flex-1 items-center gap-2">
            <span className="text-sm font-medium text-text">{agentName(agents, run.agentId)}</span>
            <StatusPill tone={STATUS_TONE[run.status]} dot={false} className="px-2 py-0.5">
              {run.status}
            </StatusPill>
          </div>
        }
      >
        {run.finalResponse && <Markdown content={run.finalResponse} />}
      </Collapsible>
    </GlassPanel>
  );
}

function PendingStepCard({ step, agents }: { step: PlanStep; agents: AgentWithStatus[] }) {
  return (
    <GlassPanel padding="md" className="opacity-50">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text">{agentName(agents, step.agentId)}</span>
        <StatusPill tone="neutral">not started</StatusPill>
      </div>
    </GlassPanel>
  );
}

export function MultiAgentPlanner({ agents }: MultiAgentPlannerProps) {
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
  const { plan, currentStepTask, liveOutput, streamingText, busy, error, start, approve, reject, cancel, reset } =
    useMultiAgentPlan();

  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<PlanStep[]>([emptyStep(), emptyStep()]);

  const planUpdatedAt = plan?.updatedAt;
  useEffect(() => {
    if (planUpdatedAt) refreshTools();
  }, [planUpdatedAt, refreshTools]);

  useEffect(() => {
    if (selectedProjectId && !projectsLoading && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, projectsLoading, selectedProjectId]);

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId((current) => (current === project.id ? null : project.id));
  };

  const updateStep = (index: number, patch: Partial<PlanStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addStep = () => setSteps((prev) => [...prev, emptyStep()]);
  const removeStep = (index: number) =>
    setSteps((prev) => (prev.length > MIN_STEPS ? prev.filter((_, i) => i !== index) : prev));

  const stepsValid = steps.length >= MIN_STEPS && steps.every((s) => s.agentId && s.objective.trim());

  const handleStart = () => {
    if (!selectedProjectId || !stepsValid || !description.trim() || busy) return;
    start(
      selectedProjectId,
      description.trim(),
      steps.map((s) => ({ agentId: s.agentId, objective: s.objective.trim() })),
    );
  };

  const handleReset = () => {
    reset();
    setDescription("");
    setSteps([emptyStep(), emptyStep()]);
  };

  const pendingExecution = currentStepTask?.pendingExecutionId
    ? executions.find((e) => e.id === currentStepTask.pendingExecutionId)
    : undefined;

  const totalSteps = plan ? plan.steps.length : 0;

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
          disabled={!!plan && !PLAN_TERMINAL_STATUSES.includes(plan.status)}
        />

        {!plan && (
          <GlassPanel padding="lg" className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-text">New Plan</h2>
            {!selectedProjectId && <p className="text-xs text-muted">Select or create a project above to start a plan.</p>}
            <textarea
              placeholder='Describe the plan, e.g. "Recon example.com and draft a findings summary."'
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              className="resize-none rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 disabled:opacity-50"
            />

            <div className="flex flex-col gap-2.5">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted">
                    {i + 1}
                  </span>
                  <select
                    value={step.agentId}
                    onChange={(e) => updateStep(i, { agentId: e.target.value })}
                    disabled={busy}
                    className="w-40 shrink-0 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs text-text outline-none focus:border-primary/60 disabled:opacity-50"
                  >
                    <option value="">Select agent…</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <textarea
                    placeholder="What should this step do?"
                    rows={2}
                    value={step.objective}
                    onChange={(e) => updateStep(i, { objective: e.target.value })}
                    disabled={busy}
                    className="flex-1 resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    disabled={busy || steps.length <= MIN_STEPS}
                    title="Remove step"
                    className="mt-1.5 shrink-0 rounded p-1 text-muted transition-colors hover:text-critical disabled:opacity-30"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="secondary" size="sm" icon={Plus} onClick={addStep} disabled={busy} className="self-start">
              Add step
            </Button>

            <Button
              variant="primary"
              onClick={handleStart}
              disabled={!selectedProjectId || !stepsValid || !description.trim() || busy}
              className="self-start"
            >
              {busy ? "Starting…" : "Run Plan"}
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

        {plan && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-sm font-medium text-text">Plan: {plan.description}</span>
              <StatusPill tone={STATUS_TONE[plan.status]} pulse={plan.status === "running"}>
                {plan.status}
              </StatusPill>
              {PLAN_TERMINAL_STATUSES.includes(plan.status) && (
                <Button variant="secondary" size="sm" onClick={handleReset} className="ml-auto">
                  New Plan
                </Button>
              )}
            </div>

            <div>
              {plan.stepRuns.slice(0, plan.currentStepIndex).map((run, i) => (
                <StepRow key={i} index={i} isLast={false} tone="primary">
                  <CompletedStepCard run={run} agents={agents} />
                </StepRow>
              ))}

              {currentStepTask && (
                <StepRow index={plan.currentStepIndex} isLast={plan.currentStepIndex === totalSteps - 1} tone="info">
                  <OrchestratorTaskView
                    task={currentStepTask}
                    headerLabel={`Step ${plan.currentStepIndex + 1} — ${agentName(agents, plan.steps[plan.currentStepIndex].agentId)}`}
                    pendingExecution={pendingExecution}
                    liveOutput={liveOutput}
                    streamingText={streamingText}
                    busy={busy}
                    error={error}
                    onApprove={approve}
                    onReject={reject}
                    onCancel={cancel}
                  />
                </StepRow>
              )}

              {plan.steps.slice(plan.currentStepIndex + 1).map((step, i) => {
                const index = plan.currentStepIndex + 1 + i;
                return (
                  <StepRow key={i} index={index} isLast={index === totalSteps - 1} tone="muted">
                    <PendingStepCard step={step} agents={agents} />
                  </StepRow>
                );
              })}
            </div>

            {plan.error && <p className="text-xs text-critical">{plan.error}</p>}
          </div>
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
