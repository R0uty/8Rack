import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  getAsset,
  getAssetByValue,
  listAssets,
  loadAssetsFromDisk,
  updateAsset,
  upsertAsset,
} from "./assetManager.js";
import { onMissionDeleted } from "./missionManager.js";
import { AssetNotFoundError } from "./errors.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
import { listActivity } from "./activityLog.js";
import type { Asset } from "../types/asset.js";

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));
const mockListMissionIds = vi.mocked(listMissionIds);
const mockReadMissionJson = vi.mocked(readMissionJson);

vi.mock("./missionManager.js", () => ({ onMissionDeleted: vi.fn() }));
const mockOnMissionDeleted = vi.mocked(onMissionDeleted);
/** Captured once, synchronously, at module load - see toolManager.test.ts's identical pattern for
 * why this can't be read lazily inside purgeMission. assetManager.ts registers its own purge
 * handler at its own top level, exactly once, when this test file's import graph first loads it. */
const registeredPurgeHandlers = mockOnMissionDeleted.mock.calls.map(([handler]) => handler);
/** Replicates exactly what the real (mocked-away) missionManager.ts#deleteMission does: call every
 * registered handler for the given id. */
function purgeMission(missionId: string) {
  for (const handler of registeredPurgeHandlers) handler(missionId);
}

describe("upsertAsset", () => {
  it("creates a new asset with firstSeen === lastSeen and sensible defaults", async () => {
    const missionId = randomUUID();
    const asset = await upsertAsset(missionId, { type: "domain", value: "example.com" });

    expect(asset.id).toBeTruthy();
    expect(asset.missionId).toBe(missionId);
    expect(asset.type).toBe("domain");
    expect(asset.value).toBe("example.com");
    expect(asset.status).toBe("active");
    expect(asset.source).toBe("manual");
    expect(asset.discoveredBy).toBe("unknown");
    expect(asset.firstSeen).toBe(asset.lastSeen);
  });

  it("logs an asset_discovered activity event for a genuinely new asset, not a repeat sighting", async () => {
    const missionId = randomUUID();
    const asset = await upsertAsset(missionId, { type: "domain", value: "example.com" });
    await upsertAsset(missionId, { type: "domain", value: "example.com" }); // repeat sighting

    const events = listActivity(missionId).filter((e) => e.type === "asset_discovered");
    expect(events).toHaveLength(1);
    expect(events[0].meta?.assetId).toBe(asset.id);
  });

  it("dedupes by (missionId, type, value): a repeat sighting updates the existing asset in place", async () => {
    const missionId = randomUUID();
    const first = await upsertAsset(missionId, { type: "port", value: "80/tcp", discoveredBy: "nmap" });
    const second = await upsertAsset(missionId, { type: "port", value: "80/tcp", discoveredBy: "httpx" });

    expect(second.id).toBe(first.id);
    expect(second.discoveredBy).toBe("httpx");
    expect(listAssets(missionId)).toHaveLength(1);
  });

  it("dedup matching is case-insensitive on value", async () => {
    const missionId = randomUUID();
    const first = await upsertAsset(missionId, { type: "subdomain", value: "Api.Example.com" });
    const second = await upsertAsset(missionId, { type: "subdomain", value: "api.example.com" });

    expect(second.id).toBe(first.id);
    expect(listAssets(missionId)).toHaveLength(1);
  });

  it("a repeat sighting merges metadata instead of replacing it", async () => {
    const missionId = randomUUID();
    await upsertAsset(missionId, { type: "ip", value: "10.0.0.1", metadata: { a: 1 } });
    const updated = await upsertAsset(missionId, { type: "ip", value: "10.0.0.1", metadata: { b: 2 } });

    expect(updated.metadata).toEqual({ a: 1, b: 2 });
  });

  it("different types with the same value do not collide", async () => {
    const missionId = randomUUID();
    await upsertAsset(missionId, { type: "domain", value: "example.com" });
    await upsertAsset(missionId, { type: "subdomain", value: "example.com" });

    expect(listAssets(missionId)).toHaveLength(2);
  });

  it("accepts an explicit status and parentId, and a later upsert can change them", async () => {
    const missionId = randomUUID();
    const parent = await upsertAsset(missionId, { type: "domain", value: "example.com" });
    const child = await upsertAsset(missionId, {
      type: "subdomain",
      value: "api.example.com",
      status: "unverified",
      parentId: parent.id,
    });
    expect(child.status).toBe("unverified");
    expect(child.parentId).toBe(parent.id);

    const reconfirmed = await upsertAsset(missionId, { type: "subdomain", value: "api.example.com", status: "active" });
    expect(reconfirmed.status).toBe("active");
    expect(reconfirmed.parentId).toBe(parent.id); // untouched when the second call omits it
  });
});

describe("getAssetByValue", () => {
  it("finds an asset by value across types, case-insensitively", async () => {
    const missionId = randomUUID();
    const created = await upsertAsset(missionId, { type: "url", value: "https://Example.com/Admin" });

    expect(getAssetByValue(missionId, "https://example.com/admin")?.id).toBe(created.id);
  });

  it("returns undefined when nothing matches", () => {
    expect(getAssetByValue(randomUUID(), "nope.example.com")).toBeUndefined();
  });
});

describe("listAssets", () => {
  it("only returns assets for the requested mission, most-recently-seen first", async () => {
    vi.useFakeTimers();
    try {
      const missionA = randomUUID();
      const missionB = randomUUID();
      await upsertAsset(missionA, { type: "domain", value: "a.com" });
      vi.advanceTimersByTime(10);
      await upsertAsset(missionB, { type: "domain", value: "b.com" });
      vi.advanceTimersByTime(10);
      const secondA = await upsertAsset(missionA, { type: "domain", value: "a2.com" });

      const listed = listAssets(missionA);
      expect(listed.map((a) => a.value)).toEqual(["a2.com", "a.com"]);
      expect(listed.every((a) => a.missionId === missionA)).toBe(true);
      expect(secondA.missionId).toBe(missionA);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("updateAsset", () => {
  it("patches status and merges metadata", async () => {
    const missionId = randomUUID();
    const asset = await upsertAsset(missionId, { type: "domain", value: "example.com", metadata: { a: 1 } });

    const updated = await updateAsset(asset.id, { status: "inactive", metadata: { b: 2 } });

    expect(updated.status).toBe("inactive");
    expect(updated.metadata).toEqual({ a: 1, b: 2 });
    expect(getAsset(asset.id)).toEqual(updated);
  });

  it("throws AssetNotFoundError for an unknown id", async () => {
    await expect(updateAsset(randomUUID(), { status: "inactive" })).rejects.toThrow(AssetNotFoundError);
  });
});

describe("onMissionDeleted purge", () => {
  it("removes every asset belonging to the deleted mission and leaves other missions untouched", async () => {
    const missionA = randomUUID();
    const missionB = randomUUID();
    await upsertAsset(missionA, { type: "domain", value: "a.com" });
    await upsertAsset(missionB, { type: "domain", value: "b.com" });

    purgeMission(missionA);

    expect(listAssets(missionA)).toEqual([]);
    expect(listAssets(missionB)).toHaveLength(1);
  });
});

describe("loadAssetsFromDisk", () => {
  it("hydrates in-memory assets from every mission's assets.json", async () => {
    const missionId = randomUUID();
    const onDisk: Asset = {
      id: randomUUID(),
      missionId,
      type: "domain",
      value: "loaded.example.com",
      status: "active",
      discoveredBy: "nmap",
      source: "scanner",
      firstSeen: 1,
      lastSeen: 1,
      metadata: {},
    };
    mockListMissionIds.mockResolvedValueOnce([missionId]);
    mockReadMissionJson.mockResolvedValueOnce([onDisk]);

    await loadAssetsFromDisk();

    expect(listAssets(missionId).some((a) => a.id === onDisk.id)).toBe(true);
  });
});
