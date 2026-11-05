import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useFindings } from "./useFindings";
import { createFinding, deleteFinding, fetchFindings, updateFinding } from "../services/findingsApi";
import type { Finding } from "../types/finding";

vi.mock("../services/findingsApi", () => ({
  fetchFindings: vi.fn(),
  createFinding: vi.fn(),
  updateFinding: vi.fn(),
  deleteFinding: vi.fn(),
}));

const mockFetchFindings = vi.mocked(fetchFindings);
const mockCreateFinding = vi.mocked(createFinding);
const mockUpdateFinding = vi.mocked(updateFinding);
const mockDeleteFinding = vi.mocked(deleteFinding);

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    missionId: "proj-1",
    type: "port",
    severity: "info",
    title: "Port 80/tcp open",
    description: "",
    source: "scanner",
    tool: "nmap",
    confidence: 0.9,
    target: "example.com",
    value: "80/tcp",
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

describe("useFindings", () => {
  it("skips fetching and stays empty when missionId is null", async () => {
    const { result } = renderHook(() => useFindings(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.findings).toEqual([]);
    expect(mockFetchFindings).not.toHaveBeenCalled();
  });

  it("loads findings scoped to a missionId", async () => {
    mockFetchFindings.mockResolvedValue([fixtureFinding()]);
    const { result } = renderHook(() => useFindings("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchFindings).toHaveBeenCalledWith("proj-1");
    expect(result.current.findings).toEqual([fixtureFinding()]);
  });

  it("re-fetches when missionId changes", async () => {
    mockFetchFindings.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ missionId }) => useFindings(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchFindings).toHaveBeenLastCalledWith("proj-2"));
  });

  it("ignores a stale previous-mission response that resolves after a mission switch", async () => {
    let resolveOld!: (findings: Finding[]) => void;
    mockFetchFindings.mockImplementation((id: string) =>
      id === "proj-1" ? new Promise<Finding[]>((r) => { resolveOld = r; }) : Promise.resolve([]),
    );

    const { result, rerender } = renderHook(({ missionId }) => useFindings(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(mockFetchFindings).toHaveBeenCalledWith("proj-1"));

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchFindings).toHaveBeenLastCalledWith("proj-2"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      resolveOld([fixtureFinding({ id: "stale-finding" })]);
    });

    expect(result.current.findings).toEqual([]);
  });

  it("surfaces a load failure", async () => {
    mockFetchFindings.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useFindings("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("create() calls the API then refreshes", async () => {
    mockFetchFindings.mockResolvedValue([]);
    mockCreateFinding.mockResolvedValue(fixtureFinding());
    const { result } = renderHook(() => useFindings("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({
        type: "port",
        severity: "info",
        title: "t",
        description: "d",
        target: "example.com",
        value: "80/tcp",
      });
    });

    expect(mockCreateFinding).toHaveBeenCalledWith("proj-1", expect.objectContaining({ value: "80/tcp" }));
    expect(mockFetchFindings).toHaveBeenCalledTimes(2);
  });

  it("update() and remove() call the API then refresh", async () => {
    mockFetchFindings.mockResolvedValue([]);
    mockUpdateFinding.mockResolvedValue(fixtureFinding({ status: "confirmed" }));
    mockDeleteFinding.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFindings("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.update("finding-1", { status: "confirmed" });
    });
    expect(mockUpdateFinding).toHaveBeenCalledWith("finding-1", { status: "confirmed" });

    await act(async () => {
      await result.current.remove("finding-1");
    });
    expect(mockDeleteFinding).toHaveBeenCalledWith("finding-1");
  });
});
