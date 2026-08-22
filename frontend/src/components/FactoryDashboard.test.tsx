import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FactoryDashboard } from "./FactoryDashboard";
import { useMissions } from "../hooks/useMissions";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useFindings } from "../hooks/useFindings";
import { useTools } from "../hooks/useTools";
import { useActivity } from "../hooks/useActivity";
import { advanceFactory } from "../services/factoryApi";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));
vi.mock("../hooks/useWorkOrders", () => ({ useWorkOrders: vi.fn() }));
vi.mock("../hooks/useFindings", () => ({ useFindings: vi.fn() }));
vi.mock("../hooks/useTools", () => ({ useTools: vi.fn() }));
vi.mock("../hooks/useActivity", () => ({ useActivity: vi.fn() }));
vi.mock("../services/factoryApi", () => ({ advanceFactory: vi.fn() }));
vi.mock("./MissionPanel", () => ({
  MissionPanel: ({ missions, onSelect }: { missions: Mission[]; onSelect: (m: Mission) => void }) => (
    <div>
      {missions.map((m) => (
        <button key={m.id} onClick={() => onSelect(m)}>
          {m.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./FactoryPipeline", () => ({ FactoryPipeline: () => <div data-testid="pipeline" /> }));
vi.mock("./ApprovalQueue", () => ({ ApprovalQueue: () => <div data-testid="approval-queue" /> }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => <div data-testid="activity-feed" /> }));

const mockUseMissions = vi.mocked(useMissions);
const mockUseAssets = vi.mocked(useAssets);
const mockUseWorkOrders = vi.mocked(useWorkOrders);
const mockUseFindings = vi.mocked(useFindings);
const mockUseTools = vi.mocked(useTools);
const mockUseActivity = vi.mocked(useActivity);
const mockAdvanceFactory = vi.mocked(advanceFactory);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1, status: "recon" };

function setupHooks() {
  mockUseMissions.mockReturnValue({
    missions: [mission],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  });
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
}

describe("FactoryDashboard", () => {
  it("prompts to select a mission before showing any stats", () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} />);
    expect(screen.getByText(/Select or create a mission/)).toBeInTheDocument();
  });

  it("shows stat tiles derived from assets/work orders/findings/executions once a mission is selected", async () => {
    setupHooks();
    render(<FactoryDashboard agents={[]} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));

    expect(screen.getByText("Assets")).toBeInTheDocument();
    expect(screen.getByText("Pending approvals")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue")).toBeInTheDocument();
  });

  it("calls advanceFactory when Start / Advance Factory is clicked", async () => {
    setupHooks();
    mockAdvanceFactory.mockResolvedValue({ mission });
    render(<FactoryDashboard agents={[]} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));
    await userEvent.setup().click(screen.getByRole("button", { name: /Start \/ Advance Factory/ }));

    await waitFor(() => expect(mockAdvanceFactory).toHaveBeenCalledWith("m1", expect.any(Function), expect.any(Object)));
  });
});
