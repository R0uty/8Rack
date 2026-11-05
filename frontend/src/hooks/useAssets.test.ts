import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAssets } from "./useAssets";
import { fetchAssets } from "../services/assetsApi";
import type { Asset } from "../types/asset";

vi.mock("../services/assetsApi", () => ({ fetchAssets: vi.fn() }));

const mockFetchAssets = vi.mocked(fetchAssets);

function fixtureAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    missionId: "m1",
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

describe("useAssets", () => {
  it("skips fetching and stays empty when missionId is null", async () => {
    const { result } = renderHook(() => useAssets(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.assets).toEqual([]);
    expect(mockFetchAssets).not.toHaveBeenCalled();
  });

  it("loads assets scoped to a missionId", async () => {
    mockFetchAssets.mockResolvedValue([fixtureAsset()]);
    const { result } = renderHook(() => useAssets("m1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchAssets).toHaveBeenCalledWith("m1");
    expect(result.current.assets).toEqual([fixtureAsset()]);
  });

  it("surfaces a load failure", async () => {
    mockFetchAssets.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAssets("m1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("re-fetches when missionId changes", async () => {
    mockFetchAssets.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ missionId }) => useAssets(missionId), {
      initialProps: { missionId: "m1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ missionId: "m2" });
    await waitFor(() => expect(mockFetchAssets).toHaveBeenLastCalledWith("m2"));
  });

  it("ignores a slow response for the previous mission after switching", async () => {
    let resolveA: (assets: Asset[]) => void = () => {};
    mockFetchAssets.mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)));
    const { result, rerender } = renderHook(({ id }) => useAssets(id), { initialProps: { id: "m-a" } });

    mockFetchAssets.mockResolvedValueOnce([fixtureAsset({ id: "from-b", missionId: "m-b" })]);
    rerender({ id: "m-b" });
    await waitFor(() => expect(result.current.assets.map((a) => a.id)).toEqual(["from-b"]));

    await act(async () => resolveA([fixtureAsset({ id: "from-a", missionId: "m-a" })]));

    expect(result.current.assets.map((a) => a.id)).toEqual(["from-b"]);
  });
});
