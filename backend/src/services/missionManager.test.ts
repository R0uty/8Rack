import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeFs } from "../test-utils/fakeFs.js";

// See agentManager.test.ts for why the factory uses a dynamic import instead of a captured outer
// variable (vi.mock is hoisted above regular top-level statements, including plain imports).
vi.mock("node:fs/promises", async () => {
  const { createFakeFs } = await import("../test-utils/fakeFs.js");
  return createFakeFs();
});

import { createMission, deleteMission, getMission, listMissions, onMissionDeleted, updateMission } from "./missionManager.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { InvalidMissionIdError, MissionNotFoundError } from "./errors.js";
import * as fakeFsModule from "node:fs/promises";
import type { Mission } from "../types/mission.js";

const fakeFs = fakeFsModule as unknown as FakeFs;

// Mirrors missionStore.ts's own MISSIONS_DIR resolution.
const MISSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/missions");

// missionDir() only accepts UUID-shaped ids (see missionStore.ts#MISSION_ID_PATTERN) - every id
// used below to exercise "not found" (as opposed to "rejected outright") must actually look like
// one, same as a real mission id minted by createMission's randomUUID().
const VALID_UNKNOWN_ID = "00000000-0000-4000-8000-000000000001";
const VALID_OLDER_ID = "00000000-0000-4000-8000-0000000000aa";
const VALID_NEWER_ID = "00000000-0000-4000-8000-0000000000bb";
const VALID_PROJ_ID = "00000000-0000-4000-8000-0000000000cc";

function seedMission(mission: Mission) {
  fakeFs.files.set(`${MISSIONS_DIR}/${mission.id}/mission.json`, JSON.stringify(mission));
}

beforeEach(() => {
  fakeFs.files.clear();
});

describe("createMission / getMission / listMissions", () => {
  it("creates a mission with a generated id and persists it", async () => {
    const mission = await createMission("Recon Alpha", "example.com in scope");

    expect(mission.id).toBeTruthy();
    expect(mission.name).toBe("Recon Alpha");
    expect(mission.notes).toBe("example.com in scope");
    expect(fakeFs.files.has(`${MISSIONS_DIR}/${mission.id}/mission.json`)).toBe(true);
  });

  it("returns undefined for a well-formed but unknown mission id", async () => {
    expect(await getMission(VALID_UNKNOWN_ID)).toBeUndefined();
  });

  it("finds a mission that was created", async () => {
    const mission = await createMission("Findable", "");
    expect(await getMission(mission.id)).toEqual(mission);
  });

  it("lists every mission sorted by createdAt descending", async () => {
    seedMission({ id: VALID_OLDER_ID, name: "Older", notes: "", createdAt: 1000 });
    seedMission({ id: VALID_NEWER_ID, name: "Newer", notes: "", createdAt: 2000 });

    const missions = await listMissions();
    expect(missions.map((p) => p.id)).toEqual([VALID_NEWER_ID, VALID_OLDER_ID]);
  });

  it("returns an empty list when no missions exist", async () => {
    expect(await listMissions()).toEqual([]);
  });

  it("migrates a legacy 4-value status to its nearest current equivalent on read", async () => {
    seedMission({ id: VALID_PROJ_ID, name: "Legacy", notes: "", createdAt: 1000, status: "active" as Mission["status"] });
    const mission = await getMission(VALID_PROJ_ID);
    expect(mission?.status).toBe("recon");
  });

  it("leaves an already-current status value untouched on read", async () => {
    seedMission({ id: VALID_PROJ_ID, name: "Current", notes: "", createdAt: 1000, status: "validating" });
    const mission = await getMission(VALID_PROJ_ID);
    expect(mission?.status).toBe("validating");
  });

  it("persists mission fields passed at creation time", async () => {
    const mission = await createMission("Recon Beta", "", {
      description: "Authorized external pentest",
      scope: ["example.com", "*.example.com"],
      outOfScope: ["staging.example.com"],
      rules: "No DoS testing",
      startDate: 1700000000000,
      status: "recon",
    });

    expect(mission.description).toBe("Authorized external pentest");
    expect(mission.scope).toEqual(["example.com", "*.example.com"]);
    expect(mission.outOfScope).toEqual(["staging.example.com"]);
    expect(mission.rules).toBe("No DoS testing");
    expect(mission.startDate).toBe(1700000000000);
    expect(mission.status).toBe("recon");
    expect(await getMission(mission.id)).toEqual(mission);
  });

  it("defaults to no mission fields when none are passed", async () => {
    const mission = await createMission("Plain", "");
    expect(mission.description).toBeUndefined();
    expect(mission.scope).toBeUndefined();
    expect(mission.status).toBeUndefined();
  });
});

describe("updateMission", () => {
  it("merges only the patched fields", async () => {
    const mission = await createMission("Original Name", "original notes");

    const updated = await updateMission(mission.id, { notes: "updated notes" });

    expect(updated.name).toBe("Original Name");
    expect(updated.notes).toBe("updated notes");
    expect(await getMission(mission.id)).toEqual(updated);
  });

  it("throws MissionNotFoundError for a well-formed but unknown id", async () => {
    await expect(updateMission(VALID_UNKNOWN_ID, { name: "x" })).rejects.toThrow(MissionNotFoundError);
  });

  it("sets mission fields on an existing mission without touching name/notes", async () => {
    const mission = await createMission("Mission Target", "some notes");

    const updated = await updateMission(mission.id, {
      scope: ["10.0.0.0/24"],
      status: "draft",
    });

    expect(updated.name).toBe("Mission Target");
    expect(updated.notes).toBe("some notes");
    expect(updated.scope).toEqual(["10.0.0.0/24"]);
    expect(updated.status).toBe("draft");
  });

  it("leaves an unset mission field untouched when the patch omits it", async () => {
    const mission = await createMission("Two Step", "", { description: "first pass" });

    const updated = await updateMission(mission.id, { status: "recon" });

    expect(updated.description).toBe("first pass");
    expect(updated.status).toBe("recon");
  });
});

describe("deleteMission", () => {
  it("removes a mission", async () => {
    const mission = await createMission("To Delete", "");
    await deleteMission(mission.id);
    expect(await getMission(mission.id)).toBeUndefined();
  });

  it("throws MissionNotFoundError deleting an already-deleted (or well-formed but unknown) id", async () => {
    const mission = await createMission("To Delete Twice", "");
    await deleteMission(mission.id);
    await expect(deleteMission(mission.id)).rejects.toThrow(MissionNotFoundError);
  });

  // Regression coverage for "ghost records persist" - every mission-scoped in-memory store
  // (toolManager's executions, orchestrator's tasks, findingsManager's findings, etc.) registers a
  // purge handler here via onMissionDeleted so it can clear its own Map on delete instead of
  // returning stale records forever (see each service's own registration + toolManager.test.ts's/
  // orchestrator.test.ts's more specific "does it actually clear the Map" coverage).
  it("calls every registered onMissionDeleted handler with the deleted mission's id", async () => {
    const handler = vi.fn();
    onMissionDeleted(handler);
    const mission = await createMission("Purge Me", "");

    await deleteMission(mission.id);

    expect(handler).toHaveBeenCalledWith(mission.id);
  });

  it("still deletes the mission and still calls the other handlers even if one handler throws", async () => {
    const failingHandler = vi.fn(() => {
      throw new Error("a store's purge handler blew up");
    });
    const okHandler = vi.fn();
    onMissionDeleted(failingHandler);
    onMissionDeleted(okHandler);
    const mission = await createMission("Purge Me Too", "");

    await expect(deleteMission(mission.id)).resolves.toBeUndefined();

    expect(failingHandler).toHaveBeenCalledWith(mission.id);
    expect(okHandler).toHaveBeenCalledWith(mission.id);
    expect(await getMission(mission.id)).toBeUndefined();
  });

  it("does not call purge handlers when deletion itself fails (mission not found)", async () => {
    const handler = vi.fn();
    onMissionDeleted(handler);
    handler.mockClear();

    await expect(deleteMission(VALID_UNKNOWN_ID)).rejects.toThrow(MissionNotFoundError);

    expect(handler).not.toHaveBeenCalledWith(VALID_UNKNOWN_ID);
  });
});

// Path-traversal regression coverage: a crafted, non-UUID-shaped id must never reach a real
// filesystem path via missionDir() - see missionStore.ts's MISSION_ID_PATTERN doc comment.
describe("malformed mission ids are rejected before touching disk", () => {
  it("getMission rejects a malformed id instead of treating it as merely 'not found'", async () => {
    await expect(getMission("nope")).rejects.toThrow(InvalidMissionIdError);
  });

  it("getMission rejects a path-traversal attempt", async () => {
    await expect(getMission("../../../../tmp/pwn")).rejects.toThrow(InvalidMissionIdError);
    expect(fakeFs.files.has("/tmp/pwn/mission.json")).toBe(false);
  });

  it("updateMission/deleteMission reject a malformed id", async () => {
    await expect(updateMission("../evil", { name: "x" })).rejects.toThrow(InvalidMissionIdError);
    await expect(deleteMission("../evil")).rejects.toThrow(InvalidMissionIdError);
  });

  it("createMission's own generated id is always accepted by missionDir (sanity check)", async () => {
    const mission = await createMission("Sanity", "");
    await expect(getMission(mission.id)).resolves.toEqual(mission);
  });
});

describe("missionStore (readMissionJson/listMissionIds/writeMissionJson)", () => {
  it("returns an empty array for a well-formed but unknown mission id", async () => {
    expect(await readMissionJson(VALID_UNKNOWN_ID, "executions.json")).toEqual([]);
    expect(await listMissionIds()).toEqual([]);
  });

  it("returns an empty array for a malformed JSON file instead of throwing", async () => {
    fakeFs.files.set(`${MISSIONS_DIR}/${VALID_PROJ_ID}/executions.json`, "{ not valid json");
    expect(await readMissionJson(VALID_PROJ_ID, "executions.json")).toEqual([]);
  });

  it("round-trips a write then read", async () => {
    await writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "a" }, { id: "b" }]);
    expect(await readMissionJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("rejects a malformed id on both read and write, without creating anything on disk", async () => {
    await expect(readMissionJson("../escape", "executions.json")).rejects.toThrow(InvalidMissionIdError);
    await expect(writeMissionJson("../escape", "executions.json", [{ id: "a" }])).rejects.toThrow(
      InvalidMissionIdError,
    );
    expect([...fakeFs.files.keys()].some((f) => f.includes("escape"))).toBe(false);
  });

  it("logs a warning for invalid JSON but stays silent for a plain missing file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await readMissionJson(VALID_UNKNOWN_ID, "executions.json"); // missing file - no warning expected
    expect(warn).not.toHaveBeenCalled();

    fakeFs.files.set(`${MISSIONS_DIR}/${VALID_PROJ_ID}/executions.json`, "{ not valid json");
    await readMissionJson(VALID_PROJ_ID, "executions.json");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(VALID_PROJ_ID);
    expect(warn.mock.calls[0][0]).toContain("executions.json");

    warn.mockRestore();
  });
});

describe("writeMissionJson serializes overlapping writes to the same mission+file", () => {
  it("blocks a second write on the same mission+file until the first one's write actually settles", async () => {
    const original = fakeFs.writeFile.bind(fakeFs);
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writeCalls = 0;
    const writeSpy = vi.spyOn(fakeFs, "writeFile").mockImplementation(async (filePath: string, content: string) => {
      writeCalls++;
      if (writeCalls === 1) await firstGate;
      return original(filePath, content);
    });

    const writeA = writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "A (older)" }]);
    const writeB = writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "B (newer)" }]);

    // Let pending microtasks settle without releasing A - if writes weren't serialized, B's own
    // writeFile would already have fired by now regardless of A still being held open.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCalls).toBe(1);

    releaseFirst();
    await Promise.all([writeA, writeB]);

    expect(writeCalls).toBe(2);
    expect(await readMissionJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "B (newer)" }]);

    writeSpy.mockRestore();
  });

  it("doesn't let two different files for the same mission block each other", async () => {
    await Promise.all([
      writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "exec" }]),
      writeMissionJson(VALID_PROJ_ID, "tasks.json", [{ id: "task" }]),
    ]);

    expect(await readMissionJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "exec" }]);
    expect(await readMissionJson(VALID_PROJ_ID, "tasks.json")).toEqual([{ id: "task" }]);
  });

  it("a failed write doesn't wedge the queue - the next write for the same mission+file still runs", async () => {
    const original = fakeFs.writeFile.bind(fakeFs);
    let calls = 0;
    const writeSpy = vi.spyOn(fakeFs, "writeFile").mockImplementation(async (filePath: string, content: string) => {
      calls++;
      if (calls === 1) throw new Error("simulated disk failure");
      return original(filePath, content);
    });

    await expect(writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "fails" }])).rejects.toThrow(
      "simulated disk failure",
    );
    await writeMissionJson(VALID_PROJ_ID, "executions.json", [{ id: "succeeds" }]);

    expect(await readMissionJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "succeeds" }]);
    writeSpy.mockRestore();
  });
});

describe("readMissionMeta (via getMission) logs a warning for invalid mission.json", () => {
  it("logs but still resolves to 'not found' rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeFs.files.set(`${MISSIONS_DIR}/${VALID_PROJ_ID}/mission.json`, "{ not valid json");

    expect(await getMission(VALID_PROJ_ID)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(VALID_PROJ_ID);

    warn.mockRestore();
  });
});
