import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMissions } from "./useMissions";
import { createMission, deleteMission, fetchMissions, updateMission } from "../services/missionsApi";
import type { Mission } from "../types/mission";

vi.mock("../services/missionsApi", () => ({
  fetchMissions: vi.fn(),
  createMission: vi.fn(),
  updateMission: vi.fn(),
  deleteMission: vi.fn(),
}));

const mockFetchMissions = vi.mocked(fetchMissions);
const mockCreateMission = vi.mocked(createMission);
const mockUpdateMission = vi.mocked(updateMission);
const mockDeleteMission = vi.mocked(deleteMission);

const fixtureMission: Mission = { id: "p1", name: "Acme", notes: "scope notes", createdAt: 0 };

describe("useMissions", () => {
  it("loads missions on mount", async () => {
    mockFetchMissions.mockResolvedValue([fixtureMission]);
    const { result } = renderHook(() => useMissions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.missions).toEqual([fixtureMission]);
  });

  it("surfaces a load failure", async () => {
    mockFetchMissions.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useMissions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("create() creates then re-fetches the list", async () => {
    mockFetchMissions.mockResolvedValueOnce([]).mockResolvedValueOnce([fixtureMission]);
    mockCreateMission.mockResolvedValue(fixtureMission);
    const { result } = renderHook(() => useMissions());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Mission | undefined;
    await act(async () => {
      created = await result.current.create("Acme", "scope notes");
    });

    expect(mockCreateMission).toHaveBeenCalledWith("Acme", "scope notes");
    expect(created).toEqual(fixtureMission);
    expect(result.current.missions).toEqual([fixtureMission]);
  });

  it("update() patches then re-fetches the list", async () => {
    mockFetchMissions.mockResolvedValue([fixtureMission]);
    const updated = { ...fixtureMission, name: "Renamed" };
    mockUpdateMission.mockResolvedValue(updated);
    const { result } = renderHook(() => useMissions());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetchMissions.mockResolvedValueOnce([updated]);
    await act(async () => {
      await result.current.update("p1", { name: "Renamed" });
    });

    expect(mockUpdateMission).toHaveBeenCalledWith("p1", { name: "Renamed" });
    expect(result.current.missions).toEqual([updated]);
  });

  it("remove() deletes then re-fetches the list", async () => {
    mockFetchMissions.mockResolvedValueOnce([fixtureMission]).mockResolvedValueOnce([]);
    mockDeleteMission.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMissions());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.remove("p1");
    });

    expect(mockDeleteMission).toHaveBeenCalledWith("p1");
    expect(result.current.missions).toEqual([]);
  });
});
