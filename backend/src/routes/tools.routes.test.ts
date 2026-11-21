import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../test-utils/httpHarness.js";
import { getMission } from "../services/missionManager.js";
import { getExecution, rejectExecution, requestExecution, setToolEnabled } from "../services/toolManager.js";
import { resumeAfterExecution } from "../services/missionRunner.js";
import { ExecutionNotFoundError, OutOfScopeError } from "../services/errors.js";
import type { ExecutionRecord } from "../types/execTool.js";

vi.mock("../services/missionManager.js", () => ({
  getMission: vi.fn(),
  listMissions: vi.fn(async () => []),
  onMissionDeleted: vi.fn(),
}));
vi.mock("../services/toolManager.js", () => ({
  cancelExecution: vi.fn(),
  confirmExecution: vi.fn(),
  getExecution: vi.fn(),
  getExecTool: vi.fn(),
  listExecToolsWithStatus: vi.fn(() => []),
  listExecutions: vi.fn(() => []),
  rejectExecution: vi.fn(),
  requestExecution: vi.fn(),
  setToolEnabled: vi.fn(),
}));
vi.mock("../services/missionRunner.js", () => ({
  getRunState: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  startWorkOrderRun: vi.fn(),
  guideWorkOrderRun: vi.fn(),
  resumeAfterExecution: vi.fn(),
}));

const M1 = "11111111-1111-4111-8111-111111111111";
const execution = { id: "ex-1", missionId: M1, toolId: "nmap", arguments: ["127.0.0.1"], status: "pending_confirmation" } as unknown as ExecutionRecord;

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMission).mockImplementation(async (id) => (id === M1 ? { id, name: "m", notes: "", createdAt: 1 } : undefined));
});

describe("/api/tools", () => {
  it("records a tool request with 201", async () => {
    vi.mocked(requestExecution).mockResolvedValue(execution);
    const res = await server.request("POST", "/api/tools/request", { tool: "nmap", arguments: ["127.0.0.1"], missionId: M1 });
    expect(res.status).toBe(201);
    expect(res.body.execution.id).toBe("ex-1");
  });

  it("rejects a malformed request and one for a mission that doesn't exist", async () => {
    expect((await server.request("POST", "/api/tools/request", { tool: "nmap", arguments: "x", missionId: M1 })).status).toBe(400);
    const res = await server.request("POST", "/api/tools/request", {
      tool: "nmap",
      arguments: [],
      missionId: "33333333-3333-4333-8333-333333333333",
    });
    expect(res.status).toBe(404);
    expect(requestExecution).not.toHaveBeenCalled();
  });

  it("maps an out-of-scope target to its error code", async () => {
    vi.mocked(requestExecution).mockRejectedValue(new OutOfScopeError(["evil.example"]));
    const res = await server.request("POST", "/api/tools/request", { tool: "nmap", arguments: ["evil.example"], missionId: M1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OUT_OF_SCOPE");
  });

  it("resumes the waiting order after a reject", async () => {
    vi.mocked(rejectExecution).mockReturnValue({ ...execution, status: "rejected" } as ExecutionRecord);
    const res = await server.request("POST", "/api/tools/executions/ex-1/reject");
    expect(res.status).toBe(200);
    expect(resumeAfterExecution).toHaveBeenCalledWith("ex-1");
  });

  it("404s an unknown execution", async () => {
    vi.mocked(getExecution).mockReturnValue(undefined);
    vi.mocked(rejectExecution).mockImplementation(() => {
      throw new ExecutionNotFoundError("nope");
    });
    expect((await server.request("POST", "/api/tools/executions/nope/reject")).status).toBe(404);
  });

  it("only accepts a boolean for enabled", async () => {
    expect((await server.request("PATCH", "/api/tools/nmap", { enabled: "yes" })).status).toBe(400);
    expect(setToolEnabled).not.toHaveBeenCalled();
  });
});
