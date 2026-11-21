import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NeedsYouQueue } from "./NeedsYouQueue";
import { cancelExecution, confirmExecution, rejectExecution } from "../services/toolsApi";
import { createWorkOrder, guideWorkOrder, startWorkOrder } from "../services/workOrdersApi";
import { dispatchMissionEvent, resetMissionEventsForTests } from "../services/missionEvents";
import type { ApprovalItem, MissionAttention } from "../types/attention";
import type { ExecutionRecord } from "../types/execTool";
import type { WorkOrder } from "../types/workOrder";
import type { AgentWithStatus } from "../types/agent";

vi.mock("../services/toolsApi", () => ({ confirmExecution: vi.fn(), rejectExecution: vi.fn(), cancelExecution: vi.fn() }));
vi.mock("../services/workOrdersApi", () => ({ createWorkOrder: vi.fn(), guideWorkOrder: vi.fn(), startWorkOrder: vi.fn() }));

const agents = [{ id: "recon-agent", name: "Recon Agent" }] as AgentWithStatus[];

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { id: "exec-1", toolId: "nmap", agentId: "recon-agent", arguments: ["-sV", "example.com"], resolvedCommand: "nmap -sV example.com", cwd: "/", status: "pending_confirmation", createdAt: 1, ...overrides };
}

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    execution: execution(),
    tool: { name: "Nmap", description: "Port and service scanner", timeoutMs: 600_000 },
    targets: ["example.com"],
    workOrder: { id: "wo-1", agentId: "recon-agent", objective: "Recon example.com" },
    agentText: "Starting with a service scan.",
    ...overrides,
  };
}

const failedOrder = { id: "wo-9", missionId: "m1", agentId: "recon-agent", objective: "Recon again", status: "failed", result: "model missing", priority: 10, dependencies: [], createdAt: 1, relatedAssets: [], relatedFindings: [] } as WorkOrder;

function setup(attention: Partial<MissionAttention>) {
  const onChanged = vi.fn();
  render(
    <NeedsYouQueue
      missionId="m1"
      missionName="Acme"
      attention={{ approvals: [], running: [], guidance: [], failed: [], ...attention }}
      agents={agents}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMissionEventsForTests();
});

describe("NeedsYouQueue", () => {
  it("shows nothing but an empty live region when nothing needs you", () => {
    setup({});
    expect(screen.queryByText(/Needs you/)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing needs you.")).toBeInTheDocument();
  });

  it("explains an approval - tool, target, timeout, order and the agent's reasoning - and approves it", async () => {
    vi.mocked(confirmExecution).mockResolvedValue(execution({ status: "running" }));
    const { onChanged } = setup({ approvals: [approval()] });

    expect(screen.getByText("Needs you (1)")).toBeInTheDocument();
    expect(screen.getByText("Recon example.com")).toBeInTheDocument();
    expect(screen.getByText("Starting with a service scan.")).toBeInTheDocument();
    expect(screen.getByText(/Port and service scanner/)).toBeInTheDocument();
    expect(screen.getByText("10 min")).toBeInTheDocument();
    expect(screen.getByText("Recon Agent")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirmExecution).toHaveBeenCalledWith("exec-1");
  });

  it("shows a scope warning instead of the all-clear, and rejects", async () => {
    vi.mocked(rejectExecution).mockResolvedValue(execution({ status: "rejected" }));
    setup({ approvals: [approval({ execution: execution({ scopeWarning: "no identifiable target" }) })] });
    expect(screen.getByText("no identifiable target")).toBeInTheDocument();
    expect(screen.queryByText("No scope warning")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reject" }));
    expect(rejectExecution).toHaveBeenCalledWith("exec-1");
  });

  it("takes a note for an order whose tool request failed", async () => {
    vi.mocked(guideWorkOrder).mockResolvedValue(failedOrder);
    setup({ guidance: [{ workOrder: { id: "wo-2", agentId: "recon-agent", objective: "Find subdomains" }, problem: "subfinder: not found" }] });
    const user = userEvent.setup();

    expect(screen.getByText("subfinder: not found")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Note for Recon Agent"), "use dig");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(guideWorkOrder).toHaveBeenCalledWith("m1", "wo-2", "use dig");
  });

  it("retries a failed order as a new one linked to it", async () => {
    vi.mocked(createWorkOrder).mockResolvedValue({ ...failedOrder, id: "wo-10", status: "pending" });
    vi.mocked(startWorkOrder).mockResolvedValue({ ...failedOrder, id: "wo-10", status: "running" });
    setup({ failed: [failedOrder] });

    expect(screen.getByText("model missing")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(startWorkOrder).toHaveBeenCalledWith("m1", "wo-10"));
    expect(createWorkOrder).toHaveBeenCalledWith("m1", expect.objectContaining({ retryOf: "wo-9", objective: "Recon again" }));
  });

  it("keeps a running tool with its live output and a Cancel", async () => {
    vi.mocked(cancelExecution).mockResolvedValue(execution({ status: "cancelled" }));
    setup({ running: [approval({ execution: execution({ status: "running" }) })] });

    act(() => dispatchMissionEvent("m1", { type: "execution_output", executionId: "exec-1", stream: "stdout", data: "80/tcp open" }));
    expect(screen.getByText("80/tcp open")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelExecution).toHaveBeenCalledWith("exec-1");
  });
});
