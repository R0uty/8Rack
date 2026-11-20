import { beforeEach, describe, expect, it, vi } from "vitest";
import { getExecTool, listExecutions } from "./toolManager.js";
import { getTask, type OrchestratorTask } from "./orchestrator.js";
import { listWorkOrders, workOrderNeedsGuidance } from "./workOrderManager.js";
import { agentProse, getMissionAttention, lastToolProblem } from "./missionAttention.js";
import type { ExecTool, ExecutionRecord } from "../types/execTool.js";
import type { WorkOrder } from "../types/workOrder.js";

vi.mock("./toolManager.js", () => ({ getExecTool: vi.fn(), listExecutions: vi.fn() }));
vi.mock("./orchestrator.js", () => ({ getTask: vi.fn() }));
vi.mock("./workOrderManager.js", () => ({ listWorkOrders: vi.fn(), workOrderNeedsGuidance: vi.fn() }));

function wo(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo-1",
    missionId: "m1",
    agentId: "recon-agent",
    objective: "Recon example.com",
    target: "example.com",
    status: "waiting_approval",
    priority: 10,
    dependencies: [],
    createdAt: 1,
    relatedAssets: [],
    relatedFindings: [],
    orchestratorTaskId: "task-1",
    ...overrides,
  };
}

function task(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return { id: "task-1", missionId: "m1", agentId: "recon-agent", objective: "", messages: [], status: "waiting_confirmation", toolExecutionIds: [], toolCallCount: 1, createdAt: 1, updatedAt: 1, ...overrides };
}

const execution = { id: "exec-1", missionId: "m1", toolId: "nmap", arguments: ["-sV", "example.com"], resolvedCommand: "nmap -sV example.com", cwd: "/", status: "pending_confirmation", createdAt: 1 } as ExecutionRecord;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workOrderNeedsGuidance).mockReturnValue(false);
  vi.mocked(listExecutions).mockReturnValue([]);
  vi.mocked(listWorkOrders).mockReturnValue([]);
});

describe("getMissionAttention", () => {
  it("explains an approval: the tool, its targets, the order it serves and what the agent said", () => {
    vi.mocked(listExecutions).mockReturnValue([execution]);
    vi.mocked(listWorkOrders).mockReturnValue([wo()]);
    vi.mocked(getTask).mockReturnValue(
      task({
        pendingExecutionId: "exec-1",
        messages: [{ role: "assistant", content: 'Checking open ports first.\n```json\n{"tool": "nmap", "arguments": ["-sV", "example.com"]}\n```' }],
      }),
    );
    vi.mocked(getExecTool).mockReturnValue({ name: "Nmap", description: "Port scanner", timeout: 600000 } as ExecTool);

    const [item] = getMissionAttention("m1").approvals;

    expect(item.tool).toEqual({ name: "Nmap", description: "Port scanner", timeoutMs: 600000 });
    expect(item.targets).toEqual(["example.com"]);
    expect(item.workOrder).toMatchObject({ id: "wo-1", objective: "Recon example.com" });
    expect(item.agentText).toBe("Checking open ports first.");
  });

  it("lists orders that need a note with the problem they hit, and failed orders nobody retried", () => {
    vi.mocked(listWorkOrders).mockReturnValue([
      wo(),
      wo({ id: "wo-2", status: "failed", result: "model missing", orchestratorTaskId: undefined }),
      wo({ id: "wo-3", status: "failed", orchestratorTaskId: undefined }),
      wo({ id: "wo-4", status: "pending", retryOf: "wo-3", orchestratorTaskId: undefined }),
    ]);
    vi.mocked(workOrderNeedsGuidance).mockImplementation((o) => o.id === "wo-1");
    vi.mocked(getTask).mockReturnValue(task({ status: "waiting_guidance", messages: [{ role: "tool", content: JSON.stringify({ error: "subfinder not installed" }) }] }));

    const attention = getMissionAttention("m1");

    expect(attention.guidance).toEqual([expect.objectContaining({ workOrder: expect.objectContaining({ id: "wo-1" }), problem: "subfinder not installed" })]);
    expect(attention.failed.map((f) => f.id)).toEqual(["wo-2"]);
    expect(attention.failed[0].result).toBe("model missing");
  });
});

describe("agentProse / lastToolProblem", () => {
  it("returns nothing when the reply was only a tool call", () => {
    expect(agentProse(task({ messages: [{ role: "assistant", content: '{"tool": "nmap", "arguments": []}' }] }))).toBeUndefined();
  });

  it("falls back to stderr for a failed run", () => {
    expect(lastToolProblem(task({ messages: [{ role: "tool", content: JSON.stringify({ stderr: "permission denied" }) }] }))).toBe("permission denied");
  });
});
