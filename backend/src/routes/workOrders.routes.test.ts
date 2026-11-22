import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../test-utils/httpHarness.js";
import { getMission } from "../services/missionManager.js";
import { cancelWorkOrder, createWorkOrder, getWorkOrder } from "../services/workOrderManager.js";
import { startWorkOrderRun, workOrderCancelled } from "../services/missionRunner.js";
import { RunInProgressError } from "../services/errors.js";
import type { WorkOrder } from "../types/workOrder.js";

vi.mock("../services/missionManager.js", () => ({
  getMission: vi.fn(),
  listMissions: vi.fn(async () => []),
  onMissionDeleted: vi.fn(),
}));
vi.mock("../services/workOrderManager.js", () => ({
  cancelWorkOrder: vi.fn(),
  createWorkOrder: vi.fn(),
  getWorkOrder: vi.fn(),
  listWorkOrders: vi.fn(() => []),
  refreshWorkOrder: vi.fn(),
  workOrderNeedsGuidance: vi.fn(() => false),
}));
vi.mock("../services/missionRunner.js", () => ({
  getRunState: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  startWorkOrderRun: vi.fn(),
  guideWorkOrderRun: vi.fn(),
  resumeAfterExecution: vi.fn(),
  workOrderCancelled: vi.fn(),
}));

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const order = (overrides: Partial<WorkOrder> = {}): WorkOrder => ({
  id: "wo-1",
  missionId: M1,
  agentId: "recon-agent",
  objective: "Recon",
  status: "pending",
  priority: 10,
  dependencies: [],
  createdAt: 1,
  relatedAssets: [],
  relatedFindings: [],
  ...overrides,
});
const base = (missionId: string) => `/api/missions/${missionId}/workorders`;

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMission).mockImplementation(async (id) => (id === M1 || id === M2 ? { id, name: id, notes: "", createdAt: 1 } : undefined));
});

describe("/api/missions/:id/workorders", () => {
  it("creates an order with 201", async () => {
    vi.mocked(createWorkOrder).mockResolvedValue(order());
    const res = await server.request("POST", base(M1), { agentId: "recon-agent", objective: "Recon" });
    expect(res.status).toBe(201);
    expect(createWorkOrder).toHaveBeenCalledWith(M1, expect.objectContaining({ agentId: "recon-agent", objective: "Recon" }));
  });

  it("validates the body", async () => {
    expect((await server.request("POST", base(M1), { objective: "x" })).status).toBe(400);
    expect((await server.request("POST", base(M1), { agentId: "a", objective: "x", dependencies: [1] })).status).toBe(400);
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it("404s a write to a mission that doesn't exist", async () => {
    const res = await server.request("POST", base("33333333-3333-4333-8333-333333333333"), { agentId: "a", objective: "x" });
    expect(res.status).toBe(404);
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it("refuses a retryOf from another mission", async () => {
    vi.mocked(getWorkOrder).mockReturnValue(order({ id: "wo-other", missionId: M2 }));
    const res = await server.request("POST", base(M1), { agentId: "a", objective: "x", retryOf: "wo-other" });
    expect(res.status).toBe(400);
  });

  it("won't start or cancel another mission's order through this mission's URL", async () => {
    vi.mocked(getWorkOrder).mockReturnValue(order({ missionId: M2 }));
    expect((await server.request("POST", `${base(M1)}/wo-1/start`)).status).toBe(404);
    expect((await server.request("POST", `${base(M1)}/wo-1/cancel`)).status).toBe(404);
    expect(startWorkOrderRun).not.toHaveBeenCalled();
    expect(cancelWorkOrder).not.toHaveBeenCalled();
  });

  it("cancels an order and lets the mission's run re-settle", async () => {
    vi.mocked(getWorkOrder).mockReturnValue(order({ status: "waiting_approval" }));
    vi.mocked(cancelWorkOrder).mockReturnValue(order({ status: "cancelled" }));
    const res = await server.request("POST", `${base(M1)}/wo-1/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.workOrder.status).toBe("cancelled");
    expect(workOrderCancelled).toHaveBeenCalledWith(M1, "wo-1");
  });

  it("answers 409 when a run is already going", async () => {
    vi.mocked(getWorkOrder).mockReturnValue(order());
    vi.mocked(startWorkOrderRun).mockImplementation(() => {
      throw new RunInProgressError(M1);
    });
    const res = await server.request("POST", `${base(M1)}/wo-1/start`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RUN_IN_PROGRESS");
  });

  it("requires a string note for guidance", async () => {
    vi.mocked(getWorkOrder).mockReturnValue(order());
    expect((await server.request("POST", `${base(M1)}/wo-1/guidance`, { note: 3 })).status).toBe(400);
  });
});
