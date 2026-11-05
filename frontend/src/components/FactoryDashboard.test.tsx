import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FactoryDashboard } from "./FactoryDashboard";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useTools } from "../hooks/useTools";
import { useActivity } from "../hooks/useActivity";
import { useReports } from "../hooks/useReports";
import { advanceFactory } from "../services/factoryApi";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));
vi.mock("../hooks/useWorkOrders", () => ({ useWorkOrders: vi.fn() }));
vi.mock("../hooks/useFindings", () => ({ useFindings: vi.fn() }));
vi.mock("../hooks/useTools", () => ({ useTools: vi.fn() }));
vi.mock("../hooks/useActivity", () => ({ useActivity: vi.fn() }));
vi.mock("../hooks/useReports", () => ({ useReports: vi.fn() }));
vi.mock("../services/factoryApi", () => ({ advanceFactory: vi.fn() }));
vi.mock("./FactoryPipeline", () => ({ FactoryPipeline: () => <div data-testid="pipeline" /> }));
vi.mock("./ApprovalQueue", () => ({
  ApprovalQueue: ({ onSettled }: { onSettled: () => void }) => (
    <button type="button" data-testid="approval-queue" onClick={onSettled}>
      settle approval
    </button>
  ),
}));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => <div data-testid="activity-feed" /> }));

const mockUseAssets = vi.mocked(useAssets);
const mockUseWorkOrders = vi.mocked(useWorkOrders);
const mockUseFindings = vi.mocked(useFindings);
const mockUseTools = vi.mocked(useTools);
const mockUseActivity = vi.mocked(useActivity);
const mockUseReports = vi.mocked(useReports);
const mockAdvanceFactory = vi.mocked(advanceFactory);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1, status: "recon" };

function setupHooks() {
  mockUseAssets.mockReturnValue({ assets: [{ id: "a1" }] as never, loading: false, error: null, refresh: vi.fn() });
  mockUseWorkOrders.mockReturnValue({
    workOrders: [{ id: "w1", status: "running" }] as never,
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refreshOne: vi.fn(),
  });
  mockUseFindings.mockReturnValue({
    findings: [{ id: "f1", status: "confirmed", severity: "critical" }] as never,
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  });
  mockUseTools.mockReturnValue({
    tools: [],
    executions: [{ id: "e1", status: "pending_confirmation" }] as never,
    loading: false,
    error: null,
    refresh: vi.fn(),
    toggleTool: vi.fn(),
  });
  mockUseActivity.mockReturnValue({ events: [], loading: false, error: null, refresh: vi.fn() });
  mockUseReports.mockReturnValue({
    reports: [],
    loading: false,
    generating: false,
    streamingText: "",
    error: null,
    refresh: vi.fn(),
    generate: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
  });
}

describe("FactoryDashboard", () => {
  it("prompts to create a mission before showing any stats", () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} mission={null} />);
    expect(screen.getByText(/Create a mission/)).toBeInTheDocument();
  });

  it("shows stat tiles derived from assets/work orders/findings/executions once a mission is selected", async () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} mission={mission} />);

    expect(screen.getByText("Assets")).toBeInTheDocument();
    expect(screen.getByText("Confirmed findings")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue")).toBeInTheDocument();
  });

  it("calls advanceFactory when Advance factory is clicked", async () => {
    setupHooks();
    mockAdvanceFactory.mockResolvedValue({ mission });
    render(<FactoryDashboard agents={[]} mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Advance factory/ }));

    await waitFor(() => expect(mockAdvanceFactory).toHaveBeenCalledWith("m1", expect.any(Function), expect.any(Object)));
  });

  it("offers a one-click report generation while a mission is at reporting with no report yet", async () => {
    const reportingMission: Mission = { ...mission, status: "reporting" };
    setupHooks();
    const generate = vi.fn().mockResolvedValue({ id: "r1" });
    mockUseReports.mockReturnValue({
      reports: [],
      loading: false,
      generating: false,
      streamingText: "",
      error: null,
      refresh: vi.fn(),
      generate,
      remove: vi.fn(),
      setStatus: vi.fn(),
    });
    render(<FactoryDashboard agents={[]} mission={reportingMission} />);

    const nudge = screen.getByRole("button", { name: "Generate report now" });
    await userEvent.setup().click(nudge);

    await waitFor(() => expect(generate).toHaveBeenCalledWith("Mission A Report", ["f1"]));
  });

  it("does not offer report generation on missions with existing reports", async () => {
    const reportingMission: Mission = { ...mission, status: "reporting" };
    setupHooks();
    mockUseReports.mockReturnValue({
      reports: [{ id: "r1" }] as never,
      loading: false,
      generating: false,
      streamingText: "",
      error: null,
      refresh: vi.fn(),
      generate: vi.fn(),
      remove: vi.fn(),
      setStatus: vi.fn(),
    });
    render(<FactoryDashboard agents={[]} mission={reportingMission} />);

    expect(screen.queryByRole("button", { name: "Generate report now" })).not.toBeInTheDocument();
  });

  it("picks the factory back up after a human settles an approval", async () => {
    setupHooks();
    mockAdvanceFactory.mockClear();
    mockAdvanceFactory.mockResolvedValue({} as never);
    render(<FactoryDashboard agents={[]} mission={mission} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("approval-queue"));

    await waitFor(() => expect(mockAdvanceFactory).toHaveBeenCalledTimes(1));
    expect(mockAdvanceFactory.mock.calls[0][0]).toBe("m1");
  });

  it("flags failed work orders and links to them", async () => {
    setupHooks();
    mockUseWorkOrders.mockReturnValue({
      workOrders: [{ id: "w1", status: "failed" }] as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
      cancel: vi.fn(),
      refreshOne: vi.fn(),
    });
    const onOpenView = vi.fn();
    render(<FactoryDashboard agents={[]} mission={mission} onOpenView={onOpenView} />);

    expect(screen.getByText(/1 work order failed/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
    expect(onOpenView).toHaveBeenCalledWith("workorders");
  });

  it("surfaces a failed report generation", async () => {
    setupHooks();
    mockUseReports.mockReturnValue({
      reports: [],
      loading: false,
      generating: false,
      streamingText: "",
      error: "The model returned an empty report",
      refresh: vi.fn(),
      generate: vi.fn(),
      remove: vi.fn(),
      setStatus: vi.fn(),
    });
    render(<FactoryDashboard agents={[]} mission={mission} />);

    expect(screen.getByText("The model returned an empty report")).toBeInTheDocument();
  });
});
