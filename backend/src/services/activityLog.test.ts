import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listActivity, loadActivityFromDisk, logActivity } from "./activityLog.js";
import { onMissionDeleted } from "./missionManager.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import type { MissionEvent } from "../types/missionEvent.js";

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));
const mockListMissionIds = vi.mocked(listMissionIds);
const mockReadMissionJson = vi.mocked(readMissionJson);
const mockWriteMissionJson = vi.mocked(writeMissionJson);

vi.mock("./missionManager.js", () => ({ onMissionDeleted: vi.fn() }));
const mockOnMissionDeleted = vi.mocked(onMissionDeleted);
/** Captured once, synchronously, at module load - see assetManager.test.ts's identical pattern for
 * why this can't be read lazily inside purgeMission. activityLog.ts registers its own purge handler
 * at its own top level, exactly once, when this test file's import graph first loads it. */
const registeredPurgeHandlers = mockOnMissionDeleted.mock.calls.map(([handler]) => handler);
function purgeMission(missionId: string) {
  for (const handler of registeredPurgeHandlers) handler(missionId);
}

describe("logActivity / listActivity", () => {
  it("persists an event and makes it retrievable, newest first", async () => {
    vi.useFakeTimers();
    try {
      const missionId = randomUUID();
      await logActivity(missionId, "mission_created", "Mission created");
      vi.advanceTimersByTime(10);
      await logActivity(missionId, "asset_discovered", "example.com discovered", { assetId: "a1" });

      const events = listActivity(missionId);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("asset_discovered");
      expect(events[0].meta).toEqual({ assetId: "a1" });
      expect(events[1].type).toBe("mission_created");
      expect(mockWriteMissionJson).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only returns events for the requested mission", async () => {
    const missionA = randomUUID();
    const missionB = randomUUID();
    await logActivity(missionA, "mission_created", "A created");
    await logActivity(missionB, "mission_created", "B created");

    expect(listActivity(missionA)).toHaveLength(1);
    expect(listActivity(missionA)[0].missionId).toBe(missionA);
  });

  it("never throws even if the underlying write fails", async () => {
    mockWriteMissionJson.mockRejectedValueOnce(new Error("disk full"));
    const missionId = randomUUID();
    await expect(logActivity(missionId, "mission_created", "Mission created")).resolves.toBeUndefined();
  });
});

describe("onMissionDeleted purge", () => {
  it("removes every event belonging to the deleted mission and leaves other missions untouched", async () => {
    const missionA = randomUUID();
    const missionB = randomUUID();
    await logActivity(missionA, "mission_created", "A created");
    await logActivity(missionB, "mission_created", "B created");

    purgeMission(missionA);

    expect(listActivity(missionA)).toEqual([]);
    expect(listActivity(missionB)).toHaveLength(1);
  });
});

describe("loadActivityFromDisk", () => {
  it("hydrates in-memory events from every mission's activity.json", async () => {
    const missionId = randomUUID();
    const onDisk: MissionEvent = {
      id: randomUUID(),
      missionId,
      type: "mission_created",
      summary: "Loaded from disk",
      createdAt: 1,
    };
    mockListMissionIds.mockResolvedValueOnce([missionId]);
    mockReadMissionJson.mockResolvedValueOnce([onDisk]);

    await loadActivityFromDisk();

    expect(listActivity(missionId).some((e) => e.id === onDisk.id)).toBe(true);
  });
});
