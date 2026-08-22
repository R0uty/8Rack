import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMission, updateMission } from "./missionManager.js";
import { listAssets } from "./assetManager.js";
import { getMissionFindings } from "./findingsManager.js";
import { createWorkOrder, dependenciesSatisfied, listWorkOrders, startWorkOrder } from "./workOrderManager.js";
import { MissionNotFoundError } from "./errors.js";
import { advanceMission } from "./factoryDirector.js";
import type { Mission } from "../types/mission.js";
import type { Asset } from "../types/asset.js";
import type { Finding } from "../types/finding.js";
import type { WorkOrder } from "../types/workOrder.js";

vi.mock("./missionManager.js", () => ({ getMission: vi.fn(), updateMission: vi.fn(), onMissionDeleted: vi.fn() }));
vi.mock("./assetManager.js", () => ({ listAssets: vi.fn() }));
vi.mock("./findingsManager.js", () => ({ getMissionFindings: vi.fn() }));
vi.mock("./workOrderManager.js", () => ({
  createWorkOrder: vi.fn(),
  dependenciesSatisfied: vi.fn(() => true),
  listWorkOrders: vi.fn(),
  startWorkOrder: vi.fn(),
}));
vi.mock("./activityLog.js", () => ({ logActivity: vi.fn() }));

const mockGetMission = vi.mocked(getMission);
const mockUpdateMission = vi.mocked(updateMission);
const mockListAssets = vi.mocked(listAssets);
const mockGetMissionFindings = vi.mocked(getMissionFindings);
const mockCreateWorkOrder = vi.mocked(createWorkOrder);
const mockDependenciesSatisfied = vi.mocked(dependenciesSatisfied);
const mockListWorkOrders = vi.mocked(listWorkOrders);
const mockStartWorkOrder = vi.mocked(startWorkOrder);

function fixtureMission(overrides: Partial<Mission> = {}): Mission {
  return { id: "mission-1", name: "Acme Pentest", notes: "", createdAt: 0, scope: ["example.com"], ...overrides };
}

function fixtureAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: randomUUID(),
    missionId: "mission-1",
    type: "domain",
    value: "example.com",
    status: "active",
    discoveredBy: "recon-agent",
    source: "agent",
    firstSeen: 0,
    lastSeen: 0,
    metadata: {},
    ...overrides,
  };
}

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    missionId: "mission-1",
    type: "potential_vulnerability",
    severity: "high",
    title: "Reflected XSS",
    description: "",
    source: "agent",
    tool: "web-analyzer",
    confidence: 0.8,
    target: "example.com",
    value: "/search?q",
    metadata: {},
    evidence: [],
    tags: [],
    status: "potential",
    history: [],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fixtureWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: randomUUID(),
    missionId: "mission-1",
    agentId: "recon-agent",
    objective: "recon",
    status: "pending",
    priority: 0,
    dependencies: [],
    createdAt: 0,
    relatedAssets: [],
    relatedFindings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDependenciesSatisfied.mockReturnValue(true);
  mockUpdateMission.mockImplementation(async (id, patch) => ({ ...fixtureMission({ id }), ...patch }));
});

describe("advanceMission", () => {
  it("throws MissionNotFoundError for an unknown mission", async () => {
    mockGetMission.mockResolvedValueOnce(undefined);
    await expect(advanceMission("nope")).rejects.toThrow(MissionNotFoundError);
  });

  it("seeds a Recon work order when the mission has no assets yet, and starts it", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValueOnce([]).mockReturnValueOnce([fixtureWorkOrder({ id: "wo-1", agentId: "recon-agent" })]);
    mockStartWorkOrder.mockResolvedValueOnce(fixtureWorkOrder({ id: "wo-1", agentId: "recon-agent", status: "waiting_approval" }));

    const result = await advanceMission("mission-1");

    expect(mockCreateWorkOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkOrder).toHaveBeenCalledWith("mission-1", expect.objectContaining({ agentId: "recon-agent" }));
    expect(mockStartWorkOrder).toHaveBeenCalledWith("wo-1", undefined, undefined);
    expect(result.workOrder?.status).toBe("waiting_approval");
  });

  it("does not seed a second Recon work order once one already exists, even if still pending", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    const existingRecon = fixtureWorkOrder({ id: "wo-1", agentId: "recon-agent" });
    mockListWorkOrders.mockReturnValue([existingRecon]);
    mockStartWorkOrder.mockResolvedValueOnce({ ...existingRecon, status: "waiting_approval" });

    await advanceMission("mission-1");

    expect(mockCreateWorkOrder).not.toHaveBeenCalled();
  });

  it("does not seed a Recon work order when the mission has no scope configured, and reports why", async () => {
    const mission = fixtureMission({ scope: undefined });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValue([]);

    const result = await advanceMission("mission-1");

    expect(mockCreateWorkOrder).not.toHaveBeenCalled();
    expect(mockStartWorkOrder).not.toHaveBeenCalled();
    expect(result.blockedReason).toMatch(/no scope configured/i);
  });

  it("seeds a fresh Recon work order once scope is added, even though a prior no-scope attempt already completed", async () => {
    // Reproduces the exact bug this fixes: a mission created via quick-create (no scope) got a
    // Recon work order seeded anyway, the agent declined to act with nothing to target, and the
    // work order settled "completed" having produced zero assets - every subsequent advance() call
    // must still be able to seed a real attempt once scope is actually configured.
    const mission = fixtureMission({ scope: ["example.com"] });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    const noOpRecon = fixtureWorkOrder({ id: "wo-old", agentId: "recon-agent", status: "completed" });
    mockListWorkOrders.mockReturnValueOnce([noOpRecon]).mockReturnValueOnce([noOpRecon, fixtureWorkOrder({ id: "wo-new", agentId: "recon-agent" })]);
    mockStartWorkOrder.mockResolvedValueOnce(fixtureWorkOrder({ id: "wo-new", agentId: "recon-agent", status: "waiting_approval" }));

    const result = await advanceMission("mission-1");

    expect(mockCreateWorkOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkOrder).toHaveBeenCalledWith("mission-1", expect.objectContaining({ agentId: "recon-agent" }));
    expect(result.workOrder?.id).toBe("wo-new");
  });

  it("seeds an Enumeration work order for a new domain/subdomain/ip asset, not for a port asset", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    const domainAsset = fixtureAsset({ id: "asset-1", type: "domain", value: "example.com" });
    const portAsset = fixtureAsset({ id: "asset-2", type: "port", value: "80/tcp" });
    mockListAssets.mockReturnValue([domainAsset, portAsset]);
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValueOnce([]).mockReturnValueOnce([fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com" })]);
    mockStartWorkOrder.mockResolvedValueOnce(
      fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com", status: "waiting_approval" }),
    );

    await advanceMission("mission-1");

    expect(mockCreateWorkOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkOrder).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ agentId: "web-analyzer", target: "example.com", relatedAssets: ["asset-1"] }),
    );
  });

  it("does not duplicate an Enumeration work order for an asset that already has one", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    const domainAsset = fixtureAsset({ id: "asset-1", type: "domain", value: "example.com" });
    mockListAssets.mockReturnValue([domainAsset]);
    mockGetMissionFindings.mockReturnValue([]);
    const existing = fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com", status: "completed" });
    mockListWorkOrders.mockReturnValue([existing]);

    await advanceMission("mission-1");

    expect(mockCreateWorkOrder).not.toHaveBeenCalled();
  });

  it("does retry a genuinely failed Enumeration work order for the same asset (unlike a completed one)", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    const domainAsset = fixtureAsset({ id: "asset-1", type: "domain", value: "example.com" });
    mockListAssets.mockReturnValue([domainAsset]);
    mockGetMissionFindings.mockReturnValue([]);
    const failedEnum = fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com", status: "failed" });
    mockListWorkOrders.mockReturnValueOnce([failedEnum]).mockReturnValueOnce([failedEnum, fixtureWorkOrder({ id: "wo-2", agentId: "web-analyzer", target: "example.com" })]);
    mockStartWorkOrder.mockResolvedValueOnce(
      fixtureWorkOrder({ id: "wo-2", agentId: "web-analyzer", target: "example.com", status: "waiting_approval" }),
    );

    await advanceMission("mission-1");

    expect(mockCreateWorkOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkOrder).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ agentId: "web-analyzer", target: "example.com" }),
    );
  });

  it("seeds a Validation work order for a potential finding, targeting the vulnerability-validator", async () => {
    const mission = fixtureMission();
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    const finding = fixtureFinding({ id: "finding-1", status: "potential" });
    mockGetMissionFindings.mockReturnValue([finding]);
    const existingEnum = fixtureWorkOrder({ id: "wo-enum", agentId: "web-analyzer", target: "example.com", status: "completed" });
    mockListWorkOrders
      .mockReturnValueOnce([existingEnum])
      .mockReturnValueOnce([existingEnum, fixtureWorkOrder({ id: "wo-validate", agentId: "vulnerability-validator" })]);
    mockStartWorkOrder.mockResolvedValueOnce(
      fixtureWorkOrder({ id: "wo-validate", agentId: "vulnerability-validator", status: "waiting_approval" }),
    );

    await advanceMission("mission-1");

    expect(mockCreateWorkOrder).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ agentId: "vulnerability-validator", relatedFindings: ["finding-1"] }),
    );
  });

  it("advances mission status to 'recon' when no assets exist yet", async () => {
    const mission = fixtureMission({ status: undefined });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValueOnce([]).mockReturnValueOnce([fixtureWorkOrder()]);
    mockStartWorkOrder.mockResolvedValueOnce(fixtureWorkOrder({ status: "waiting_approval" }));

    await advanceMission("mission-1");

    expect(mockUpdateMission).toHaveBeenCalledWith("mission-1", { status: "recon" });
  });

  it("advances mission status to 'investigating' once assets exist and findings are unsettled", async () => {
    const mission = fixtureMission({ status: "recon" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    mockGetMissionFindings.mockReturnValue([fixtureFinding({ status: "potential" })]);
    const validateWo = fixtureWorkOrder({ id: "wo-validate", agentId: "vulnerability-validator", status: "pending" });
    mockListWorkOrders.mockReturnValue([validateWo]);
    mockStartWorkOrder.mockResolvedValueOnce({ ...validateWo, status: "waiting_approval" });

    await advanceMission("mission-1");

    expect(mockUpdateMission).toHaveBeenCalledWith("mission-1", { status: "investigating" });
  });

  it("advances mission status to 'reporting' once every finding is settled and nothing is left to run", async () => {
    const mission = fixtureMission({ status: "validating" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    mockGetMissionFindings.mockReturnValue([fixtureFinding({ status: "confirmed" })]);
    mockListWorkOrders.mockReturnValue([fixtureWorkOrder({ status: "completed" })]);

    const result = await advanceMission("mission-1");

    expect(mockUpdateMission).toHaveBeenCalledWith("mission-1", { status: "reporting" });
    expect(mockStartWorkOrder).not.toHaveBeenCalled();
    expect(result.workOrder).toBeUndefined();
  });

  it("never moves a mission backwards, and never touches one a human parked at paused/cancelled/review/completed", async () => {
    const mission = fixtureMission({ status: "reporting" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([]); // would otherwise compute "recon", behind "reporting"
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValueOnce([]).mockReturnValueOnce([fixtureWorkOrder()]);
    mockStartWorkOrder.mockResolvedValueOnce(fixtureWorkOrder({ status: "waiting_approval" }));

    await advanceMission("mission-1");
    expect(mockUpdateMission).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockDependenciesSatisfied.mockReturnValue(true);
    const pausedMission = fixtureMission({ status: "paused" });
    mockGetMission.mockResolvedValue(pausedMission);
    mockListAssets.mockReturnValue([]);
    mockGetMissionFindings.mockReturnValue([]);
    mockListWorkOrders.mockReturnValue([]);

    await advanceMission("mission-1");
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it("pauses the chain (does not recurse) when the started work order settles at waiting_approval, failed, or cancelled", async () => {
    const mission = fixtureMission({ status: "recon" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    mockGetMissionFindings.mockReturnValue([]);
    const wo = fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com" });
    mockListWorkOrders.mockReturnValue([wo]);
    mockStartWorkOrder.mockResolvedValueOnce({ ...wo, status: "failed" });

    const result = await advanceMission("mission-1");

    expect(result.workOrder?.status).toBe("failed");
    expect(mockGetMission).toHaveBeenCalledTimes(1); // no recursive re-entry
  });

  it("recurses to pick up the next runnable work order once one completes", async () => {
    const mission = fixtureMission({ status: "recon" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    mockGetMissionFindings.mockReturnValue([]);
    const first = fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com", priority: 5 });
    const second = fixtureWorkOrder({ id: "wo-2", agentId: "web-analyzer", target: "other.example.com", priority: 1 });
    mockListWorkOrders
      .mockReturnValueOnce([first, second])
      .mockReturnValueOnce([first, second])
      .mockReturnValueOnce([{ ...first, status: "completed" }, second])
      .mockReturnValueOnce([{ ...first, status: "completed" }, second]);
    mockStartWorkOrder
      .mockResolvedValueOnce({ ...first, status: "completed" })
      .mockResolvedValueOnce({ ...second, status: "waiting_approval" });

    const result = await advanceMission("mission-1");

    expect(mockStartWorkOrder).toHaveBeenCalledTimes(2);
    expect(mockStartWorkOrder).toHaveBeenNthCalledWith(1, "wo-1", undefined, undefined);
    expect(mockStartWorkOrder).toHaveBeenNthCalledWith(2, "wo-2", undefined, undefined);
    expect(result.workOrder?.id).toBe("wo-2");
  });

  it("skips a pending work order whose dependencies aren't satisfied", async () => {
    const mission = fixtureMission({ status: "recon" });
    mockGetMission.mockResolvedValue(mission);
    mockListAssets.mockReturnValue([fixtureAsset()]);
    mockGetMissionFindings.mockReturnValue([]);
    const blocked = fixtureWorkOrder({ id: "wo-1", agentId: "web-analyzer", target: "example.com", dependencies: ["wo-0"] });
    mockListWorkOrders.mockReturnValue([blocked]);
    mockDependenciesSatisfied.mockReturnValue(false);

    const result = await advanceMission("mission-1");

    expect(mockStartWorkOrder).not.toHaveBeenCalled();
    expect(result.workOrder).toBeUndefined();
  });
});
