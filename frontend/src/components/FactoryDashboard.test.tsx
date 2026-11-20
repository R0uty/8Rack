import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FactoryDashboard } from "./FactoryDashboard";
import { describePreview } from "../lib/attention";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useAttention, useFactoryPreview } from "../hooks/useAttention";
import { AppNavContext } from "../lib/appNav";
import { useActivity } from "../hooks/useActivity";
import { useReports } from "../hooks/useReports";
import { advanceFactory, stopFactory } from "../services/factoryApi";
import { dispatchMissionEvent, resetMissionEventsForTests } from "../services/missionEvents";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));
vi.mock("../hooks/useWorkOrders", () => ({ useWorkOrders: vi.fn() }));
vi.mock("../hooks/useFindings", () => ({ useFindings: vi.fn() }));
vi.mock("../hooks/useAttention", () => ({ useAttention: vi.fn(), useFactoryPreview: vi.fn() }));
vi.mock("../hooks/useActivity", () => ({ useActivity: vi.fn() }));
vi.mock("../hooks/useReports", () => ({ useReports: vi.fn() }));
vi.mock("../services/factoryApi", () => ({ advanceFactory: vi.fn(), stopFactory: vi.fn() }));
vi.mock("./FactoryPipeline", () => ({ FactoryPipeline: () => <div data-testid="pipeline" /> }));
vi.mock("./NeedsYouQueue", () => ({
  NeedsYouQueue: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" data-testid="approval-queue" onClick={onChanged}>
      settle approval
    </button>
  ),
}));
vi.mock("./SetupChecklist", () => ({ SetupChecklist: () => null }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => <div data-testid="activity-feed" /> }));

const mockUseAssets = vi.mocked(useAssets);
const mockUseWorkOrders = vi.mocked(useWorkOrders);
const mockUseFindings = vi.mocked(useFindings);
const mockUseAttention = vi.mocked(useAttention);
const mockUseFactoryPreview = vi.mocked(useFactoryPreview);
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
    guide: vi.fn(),
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
  mockUseAttention.mockReturnValue({
    attention: { approvals: [{ execution: { id: "e1" } }] as never, running: [], guidance: [], failed: [] },
    error: null,
    refresh: vi.fn(),
  });
  mockUseFactoryPreview.mockReturnValue({ preview: null, error: null, refresh: vi.fn() });
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

const runState = (status: "running" | "blocked" | "idle", extra: { workOrderId?: string; reason?: string } = {}) => ({
  type: "run_state" as const,
  run: { missionId: "m1", status, updatedAt: 1, ...extra },
});

beforeEach(() => resetMissionEventsForTests());

describe("FactoryDashboard", () => {
  it("prompts to create a mission before showing any stats", () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} mission={null} />);
    expect(screen.getByText(/No mission selected/)).toBeInTheDocument();
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
    mockAdvanceFactory.mockResolvedValue({ missionId: "m1", status: "running", updatedAt: 1 });
    render(<FactoryDashboard agents={[]} mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Advance factory/ }));

    await waitFor(() => expect(mockAdvanceFactory).toHaveBeenCalledWith("m1"));
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

  it("leaves resuming to the server after a human settles an approval", async () => {
    setupHooks();
    mockAdvanceFactory.mockClear();
    render(<FactoryDashboard agents={[]} mission={mission} />);

    await userEvent.setup().click(screen.getByTestId("approval-queue"));

    expect(mockAdvanceFactory).not.toHaveBeenCalled();
  });

  it("shows which order is running, its output, and a Stop while the server's run is going", async () => {
    setupHooks();
    vi.mocked(stopFactory).mockResolvedValue({ missionId: "m1", status: "running", updatedAt: 1 });
    mockUseWorkOrders.mockReturnValue({
      workOrders: [{ id: "w1", status: "running", agentId: "recon-agent", objective: "Recon example.com" }] as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
      cancel: vi.fn(),
      guide: vi.fn(),
      refreshOne: vi.fn(),
    });
    render(<FactoryDashboard agents={[]} mission={mission} />);

    act(() => {
      dispatchMissionEvent("m1", runState("running"));
      dispatchMissionEvent("m1", { type: "chunk", workOrderId: "w1", content: "Scanning ports" });
    });

    expect(screen.getByText(/recon-agent - Recon example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Scanning ports/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Advance factory/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Stop/ }));
    expect(stopFactory).toHaveBeenCalledWith("m1");
  });

  it("shows why the run stopped, from the server's run state", () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} mission={mission} />);
    act(() => dispatchMissionEvent("m1", runState("blocked", { reason: "Paused after 25 work orders in one run" })));
    expect(screen.getByText(/Paused after 25 work orders/)).toBeInTheDocument();
  });

  it("says what Advance would do next", () => {
    setupHooks();
    mockUseFactoryPreview.mockReturnValue({
      preview: { next: { agentId: "recon-agent", target: "example.com", objective: "Recon", existing: false }, waitingOnApproval: 0, waitingOnGuidance: 0, unsettledFindings: 0, confirmedFindings: 0 },
      error: null,
      refresh: vi.fn(),
    });
    render(<FactoryDashboard agents={[{ id: "recon-agent", name: "Recon Agent" } as never]} mission={mission} />);
    expect(screen.getByText("Next: Recon Agent on example.com (new work order).")).toBeInTheDocument();
  });

  it("puts the number of items waiting on you in the tab title", () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} mission={mission} />);
    expect(document.title).toBe("(1) 8Rack");
  });

  it("opens the mission editor from the no-scope warning", async () => {
    setupHooks();
    const editMission = vi.fn();
    render(
      <AppNavContext.Provider value={{ editMission }}>
        <FactoryDashboard agents={[]} mission={{ ...mission, scope: [] }} />
      </AppNavContext.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /No scope set/ }));
    expect(editMission).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
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

describe("describePreview", () => {
  const base = { waitingOnApproval: 0, waitingOnGuidance: 0, unsettledFindings: 0, confirmedFindings: 0 };
  it("says why nothing would run", () => {
    expect(describePreview({ ...base, unsettledFindings: 3 }, [])).toBe("Nothing to run - 3 findings need review.");
    expect(describePreview({ ...base, waitingOnApproval: 1 }, [])).toBe("Nothing new to run - 1 work order is waiting on you.");
    expect(describePreview({ ...base, blockedReason: "This mission is paused" }, [])).toBe("This mission is paused");
    expect(describePreview(base, [])).toBe("Nothing to run right now.");
  });
});
