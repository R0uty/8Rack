import { getExecTool, listExecutions } from "./toolManager.js";
import { getTask, type OrchestratorTask } from "./orchestrator.js";
import { listWorkOrders, workOrderNeedsGuidance } from "./workOrderManager.js";
import { extractTargets } from "./scopeMatcher.js";
import type { ExecutionRecord } from "../types/execTool.js";
import type { WorkOrder } from "../types/workOrder.js";

/** The work order an item belongs to, with only what a card shows. */
export interface AttentionWorkOrder {
  id: string;
  agentId: string;
  objective: string;
  target?: string;
}

export interface ApprovalItem {
  execution: ExecutionRecord;
  tool?: { name: string; description: string; timeoutMs: number };
  /** Hosts, IPs and URLs found in the arguments - what the command would touch. */
  targets: string[];
  workOrder?: AttentionWorkOrder;
  /** What the agent wrote alongside the request, with the tool-call JSON taken out. */
  agentText?: string;
}

export interface GuidanceItem {
  workOrder: AttentionWorkOrder;
  /** The error or stderr the paused tool request ended with. */
  problem?: string;
  agentText?: string;
}

export interface MissionAttention {
  approvals: ApprovalItem[];
  /** Approved runs still going - shown with live output and Cancel. */
  running: ApprovalItem[];
  guidance: GuidanceItem[];
  /** Failed orders nobody has retried yet - whole, so a Retry can recreate them. */
  failed: WorkOrder[];
}

/** Long enough for a paragraph of reasoning, short enough for a card. */
const AGENT_TEXT_LIMIT = 600;

function summarize(wo: WorkOrder): AttentionWorkOrder {
  return { id: wo.id, agentId: wo.agentId, objective: wo.objective, target: wo.target };
}

function lastMessage(task: OrchestratorTask | undefined, role: "assistant" | "tool") {
  const messages = task?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return messages[i];
  return undefined;
}

/** The agent's prose from its latest reply, without fenced blocks or bare tool-call JSON. */
export function agentProse(task: OrchestratorTask | undefined): string | undefined {
  const last = lastMessage(task, "assistant");
  if (!last) return undefined;
  const prose = last.content
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((line: string) => !/^\s*[[{]\s*"tool"/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!prose) return undefined;
  return prose.length > AGENT_TEXT_LIMIT ? `${prose.slice(0, AGENT_TEXT_LIMIT)}…` : prose;
}

/** What went wrong, from the tool result a paused task stopped on - a refused request carries
 * `error`, a run that failed carries its `stderr`. */
export function lastToolProblem(task: OrchestratorTask | undefined): string | undefined {
  const last = lastMessage(task, "tool");
  if (!last) return undefined;
  try {
    const result = JSON.parse(last.content) as { error?: unknown; message?: unknown; stderr?: unknown };
    return [result.error, result.message, result.stderr].find((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return undefined;
  }
}

/**
 * Everything on a mission waiting on a human, with what each card needs to explain itself. Before
 * this, the dashboard's queue showed agent, command and a scope line; a paused order needing a note
 * was only reachable through Work Orders → Inspect; failed orders were a count.
 */
export function getMissionAttention(missionId: string): MissionAttention {
  const workOrders = listWorkOrders(missionId);
  const tasks = new Map<string, OrchestratorTask>();
  for (const wo of workOrders) {
    const task = wo.orchestratorTaskId ? getTask(wo.orchestratorTaskId) : undefined;
    if (task) tasks.set(wo.id, task);
  }
  const orderFor = (executionId: string) =>
    workOrders.find((wo) => {
      const task = tasks.get(wo.id);
      return task?.pendingExecutionId === executionId || task?.toolExecutionIds.includes(executionId);
    });

  const toItem = (execution: ExecutionRecord): ApprovalItem => {
    const tool = getExecTool(execution.toolId);
    const wo = orderFor(execution.id);
    const task = wo ? tasks.get(wo.id) : undefined;
    return {
      execution,
      tool: tool && { name: tool.name, description: tool.description, timeoutMs: tool.timeout },
      targets: extractTargets(execution.arguments),
      workOrder: wo && summarize(wo),
      // The prose only belongs to this request while it's the one the task is paused on.
      agentText: task?.pendingExecutionId === execution.id ? agentProse(task) : undefined,
    };
  };

  const executions = listExecutions(missionId);
  const retried = new Set(workOrders.map((wo) => wo.retryOf).filter(Boolean));

  return {
    approvals: executions.filter((e) => e.status === "pending_confirmation").map(toItem),
    running: executions.filter((e) => e.status === "running").map(toItem),
    guidance: workOrders.filter(workOrderNeedsGuidance).map((wo) => ({
      workOrder: summarize(wo),
      problem: lastToolProblem(tasks.get(wo.id)),
      agentText: agentProse(tasks.get(wo.id)),
    })),
    failed: workOrders.filter((wo) => wo.status === "failed" && !retried.has(wo.id)),
  };
}
