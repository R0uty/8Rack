import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkOrdersView } from "./WorkOrdersView";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { fetchTask, provideGuidance } from "../services/orchestratorApi";
import type { Mission } from "../types/mission";
import type { WorkOrder } from "../types/workOrder";
import type { OrchestratorTask } from "../types/orchestrator";

vi.mock("../hooks/useWorkOrders", () => ({ useWorkOrders: vi.fn() }));
vi.mock("../services/orchestratorApi", () => ({ fetchTask: vi.fn(), provideGuidance: vi.fn() }));

const mockUseWorkOrders = vi.mocked(useWorkOrders);
const mockFetchTask = vi.mocked(fetchTask);
const mockProvideGuidance = vi.mocked(provideGuidance);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1 };

function fixtureWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo-1",
    missionId: "m1",
    agentId: "recon-agent",
    objective: "Recon example.com",
    status: "running",
    priority: 1,
    dependencies: [],
    createdAt: 1,
    relatedAssets: [],
    relatedFindings: [],
    orchestratorTaskId: "task-1",
    ...overrides,
  };
}

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "task-1",
    agentId: "recon-agent",
    objective: "Recon example.com",
    messages: [],
    status: "completed",
    toolExecutionIds: [],
    toolCallCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as OrchestratorTask;
}

function setup(workOrders: WorkOrder[], overrides: Partial<ReturnType<typeof useWorkOrders>> = {}) {
  const refreshOne = overrides.refreshOne ?? vi.fn().mockResolvedValue(workOrders[0]);
  mockUseWorkOrders.mockReturnValue({
    workOrders,
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refreshOne,
    ...overrides,
  });
  return { refreshOne };
}

describe("WorkOrdersView", () => {
  it("shows an empty state pointing at the Factory Dashboard when there are no work orders yet", async () => {
    setup([]);
    render(<WorkOrdersView mission={mission} />);
    expect(screen.getByText(/No work orders yet/)).toBeInTheDocument();
  });

  it("groups work orders by status", async () => {
    setup([fixtureWorkOrder({ id: "wo-1", status: "running" }), fixtureWorkOrder({ id: "wo-2", status: "completed" })]);
    render(<WorkOrdersView mission={mission} />);

    expect(screen.getByText("running (1)")).toBeInTheDocument();
    expect(screen.getByText("completed (1)")).toBeInTheDocument();
  });

  it("re-syncs status before fetching, then shows the underlying task's final response on Inspect", async () => {
    const { refreshOne } = setup([fixtureWorkOrder({ status: "running" })]);
    mockFetchTask.mockResolvedValue(fixtureTask({ status: "completed", finalResponse: "Found 3 open ports." }));

    render(<WorkOrdersView mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Inspect" }));

    expect(refreshOne).toHaveBeenCalledWith("wo-1");
    expect(mockFetchTask).toHaveBeenCalledWith("task-1");
    await waitFor(() => expect(screen.getByText("Found 3 open ports.")).toBeInTheDocument());
  });

  it("points a pending tool confirmation at the Approval Queue", async () => {
    setup([fixtureWorkOrder({ status: "waiting_approval" })]);
    mockFetchTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation" }));

    render(<WorkOrdersView mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Inspect" }));

    await waitFor(() => expect(screen.getByText(/Approval Queue/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("gives a failed tool request a real guidance action, not just a message", async () => {
    setup([fixtureWorkOrder({ status: "waiting_approval" })]);
    mockFetchTask.mockResolvedValue(fixtureTask({ status: "waiting_guidance" }));
    mockProvideGuidance.mockResolvedValue(fixtureTask({ status: "completed", finalResponse: "Retried successfully." }));

    render(<WorkOrdersView mission={mission} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Inspect" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/Optional note/), "use dig instead");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mockProvideGuidance).toHaveBeenCalledWith("task-1", "use dig instead", expect.any(Function), expect.any(AbortSignal));
    await waitFor(() => expect(screen.getByText("Retried successfully.")).toBeInTheDocument());
  });

  it("shows what went wrong on a paused order, so a human can write a useful note", async () => {
    setup([fixtureWorkOrder({ status: "waiting_approval" })]);
    mockFetchTask.mockResolvedValue(
      fixtureTask({
        status: "waiting_guidance",
        messages: [{ role: "tool", content: JSON.stringify({ error: 'Tool "query_agents" was not found' }) }],
      }),
    );

    render(<WorkOrdersView mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Inspect" }));

    await waitFor(() => expect(screen.getByText('Tool "query_agents" was not found')).toBeInTheDocument());
  });

  it("shows a Retry button for a failed work order that recreates and starts it", async () => {
    const create = vi.fn().mockResolvedValue(fixtureWorkOrder({ id: "wo-2", status: "pending" }));
    const start = vi.fn().mockResolvedValue(fixtureWorkOrder({ id: "wo-2", status: "running" }));
    setup([fixtureWorkOrder({ status: "failed", target: "example.com" })], { create, start });

    render(<WorkOrdersView mission={mission} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "recon-agent", objective: "Recon example.com", target: "example.com" }),
      ),
    );
    expect(start).toHaveBeenCalledWith("wo-2");
  });

  it("does not show Retry for a running or completed work order", async () => {
    setup([fixtureWorkOrder({ status: "completed" })]);
    render(<WorkOrdersView mission={mission} />);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("cancels a non-terminal order", async () => {
    const cancel = vi.fn().mockResolvedValue(fixtureWorkOrder({ id: "wo-1", status: "cancelled" }));
    setup([fixtureWorkOrder({ id: "wo-1", status: "waiting_approval" })], { cancel });
    render(<WorkOrdersView mission={mission} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cancel).toHaveBeenCalledWith("wo-1");
  });

  it("offers no cancel on a finished order", async () => {
    setup([fixtureWorkOrder({ id: "wo-1", status: "completed" })]);
    render(<WorkOrdersView mission={mission} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("shows why a cancel failed", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already finished"));
    setup([fixtureWorkOrder({ id: "wo-1", status: "running" })], { cancel });
    render(<WorkOrdersView mission={mission} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("already finished")).toBeInTheDocument();
  });

  it("shows why a retry failed instead of an unhandled rejection", async () => {
    const create = vi.fn().mockRejectedValue(new Error("mission is gone"));
    setup([fixtureWorkOrder({ id: "wo-1", status: "failed" })], { create });
    render(<WorkOrdersView mission={mission} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("mission is gone")).toBeInTheDocument();
  });
});
