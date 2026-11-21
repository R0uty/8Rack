import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../test-utils/httpHarness.js";
import { createMission, deleteMission, getMission, updateMission } from "../services/missionManager.js";
import { stopRun } from "../services/missionRunner.js";
import type { Mission } from "../types/mission.js";

vi.mock("../services/missionManager.js", () => ({
  createMission: vi.fn(),
  deleteMission: vi.fn(),
  getMission: vi.fn(),
  listMissions: vi.fn(async () => []),
  updateMission: vi.fn(),
  onMissionDeleted: vi.fn(),
}));
vi.mock("../services/activityLog.js", () => ({ logActivity: vi.fn(), listActivity: vi.fn(() => []) }));
vi.mock("../services/missionRunner.js", () => ({
  getRunState: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  startWorkOrderRun: vi.fn(),
  guideWorkOrderRun: vi.fn(),
  resumeAfterExecution: vi.fn(),
}));

const M1 = "11111111-1111-4111-8111-111111111111";
const mission = (overrides: Partial<Mission> = {}): Mission => ({ id: M1, name: "Acme", notes: "", createdAt: 1, ...overrides });

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());
beforeEach(() => vi.clearAllMocks());

describe("/api/missions", () => {
  it("creates a mission with 201", async () => {
    vi.mocked(createMission).mockResolvedValue(mission({ scope: ["example.com"] }));
    const res = await server.request("POST", "/api/missions", { name: " Acme ", scope: ["example.com"] });
    expect(res.status).toBe(201);
    expect(res.body.mission.id).toBe(M1);
    expect(createMission).toHaveBeenCalledWith("Acme", "", expect.objectContaining({ scope: ["example.com"] }));
  });

  it("rejects a missing name and a bad status with 400", async () => {
    expect((await server.request("POST", "/api/missions", {})).status).toBe(400);
    const res = await server.request("POST", "/api/missions", { name: "x", status: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
    expect(createMission).not.toHaveBeenCalled();
  });

  it("404s a mission that doesn't exist", async () => {
    vi.mocked(getMission).mockResolvedValue(undefined);
    const res = await server.request("GET", `/api/missions/${M1}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("MISSION_NOT_FOUND");
  });

  it("patches a status", async () => {
    vi.mocked(getMission).mockResolvedValue(mission({ status: "recon" }));
    vi.mocked(updateMission).mockResolvedValue(mission({ status: "paused" }));
    const res = await server.request("PATCH", `/api/missions/${M1}`, { status: "paused" });
    expect(res.status).toBe(200);
    expect(updateMission).toHaveBeenCalledWith(M1, expect.objectContaining({ status: "paused" }));
  });

  it("stops the run before deleting", async () => {
    vi.mocked(deleteMission).mockResolvedValue(undefined);
    const res = await server.request("DELETE", `/api/missions/${M1}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(stopRun).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteMission).mock.invocationCallOrder[0]);
  });

  it("refuses a write from another site", async () => {
    const res = await server.request("POST", "/api/missions", { name: "x" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(createMission).not.toHaveBeenCalled();
  });
});
