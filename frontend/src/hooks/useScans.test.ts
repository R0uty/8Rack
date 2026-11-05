import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useScans } from "./useScans";
import { cancelScan, createScan, fetchScanProfiles, fetchScans, previewScan } from "../services/scannersApi";
import type { ScanPreview, ScanProfile, ScanRun } from "../types/scanner";

vi.mock("../services/scannersApi", () => ({
  fetchScanProfiles: vi.fn(),
  fetchScans: vi.fn(),
  previewScan: vi.fn(),
  createScan: vi.fn(),
  cancelScan: vi.fn(),
}));

const mockFetchScanProfiles = vi.mocked(fetchScanProfiles);
const mockFetchScans = vi.mocked(fetchScans);
const mockPreviewScan = vi.mocked(previewScan);
const mockCreateScan = vi.mocked(createScan);
const mockCancelScan = vi.mocked(cancelScan);

const fixtureProfile: ScanProfile = {
  id: "quick-recon",
  name: "Quick Recon",
  description: "Fast first pass.",
  icon: "🧭",
  steps: [{ toolId: "dig", arguments: ["{target}"] }],
};

const fixturePreview: ScanPreview = {
  profile: { id: "quick-recon", name: "Quick Recon", description: "Fast first pass.", icon: "🧭" },
  target: "example.com",
  steps: [
    { toolId: "dig", label: "Dig", arguments: ["example.com"], resolvedCommand: "dig example.com", available: true },
  ],
};

function fixtureRun(overrides: Partial<ScanRun> = {}): ScanRun {
  return {
    id: "scan-1",
    missionId: "proj-1",
    profileId: "quick-recon",
    profileName: "Quick Recon",
    target: "example.com",
    status: "running",
    steps: [{ toolId: "dig", label: "Dig", arguments: ["example.com"], status: "pending" }],
    createdAt: 0,
    ...overrides,
  };
}

describe("useScans", () => {
  it("loads profiles and skips scan history when missionId is null", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    const { result } = renderHook(() => useScans(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.profiles).toEqual([fixtureProfile]);
    expect(result.current.scans).toEqual([]);
    expect(mockFetchScans).not.toHaveBeenCalled();
  });

  it("loads scan history scoped to a missionId", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([fixtureRun()]);
    const { result } = renderHook(() => useScans("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchScans).toHaveBeenCalledWith("proj-1");
    expect(result.current.scans).toEqual([fixtureRun()]);
  });

  it("ignores a stale previous-mission response that resolves after a mission switch", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    let resolveOld!: (scans: ScanRun[]) => void;
    mockFetchScans.mockImplementation((id: string) =>
      id === "proj-1" ? new Promise<ScanRun[]>((r) => { resolveOld = r; }) : Promise.resolve([]),
    );

    const { result, rerender } = renderHook(({ missionId }) => useScans(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(mockFetchScans).toHaveBeenCalledWith("proj-1"));

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchScans).toHaveBeenLastCalledWith("proj-2"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      resolveOld([fixtureRun({ id: "stale-scan" })]);
    });

    expect(result.current.scans).toEqual([]);
  });

  it("surfaces a load failure", async () => {
    mockFetchScanProfiles.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useScans(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("runPreview() is a no-op without a missionId", async () => {
    mockFetchScanProfiles.mockResolvedValue([]);
    const { result } = renderHook(() => useScans(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });

    expect(mockPreviewScan).not.toHaveBeenCalled();
  });

  it("runPreview() fetches and stores the preview", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });

    expect(mockPreviewScan).toHaveBeenCalledWith("proj-1", "quick-recon", "example.com");
    expect(result.current.preview).toEqual(fixturePreview);
  });

  it("clearPreview() clears a stored preview", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });
    expect(result.current.preview).not.toBeNull();

    act(() => result.current.clearPreview());
    expect(result.current.preview).toBeNull();
  });

  it("runScan() streams scan/step/output events into `run`/`liveOutput`, then settles and records history", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);

    const runningStep = { toolId: "dig", label: "Dig", arguments: ["example.com"], status: "running" as const };
    const doneStep = { ...runningStep, status: "completed" as const, resolvedCommand: "dig example.com" };
    const finished = fixtureRun({ status: "completed", steps: [doneStep] });

    mockCreateScan.mockImplementation(async (_missionId, _profileId, _target, onEvent) => {
      onEvent({ type: "scan", scan: fixtureRun() });
      onEvent({ type: "step", step: runningStep });
      onEvent({ type: "output", toolId: "dig", stream: "stdout", data: "answer section..." });
      onEvent({ type: "step", step: doneStep });
      return finished;
    });

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });

    await act(async () => {
      await result.current.runScan();
    });

    expect(mockCreateScan).toHaveBeenCalledWith("proj-1", "quick-recon", "example.com", expect.any(Function));
    expect(result.current.preview).toBeNull();
    expect(result.current.run).toEqual(finished);
    expect(result.current.run?.steps[0].status).toBe("completed");
    expect(result.current.liveOutput).toEqual([{ stream: "stdout", data: "answer section..." }]);
    expect(result.current.scans).toEqual([finished]);
    expect(result.current.running).toBe(false);
  });

  it("runScan() is a no-op without a missionId or a preview", async () => {
    mockFetchScanProfiles.mockResolvedValue([]);
    const { result } = renderHook(() => useScans(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runScan();
    });

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not append a scan that finishes after the mission changed", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);

    const doneStep = {
      toolId: "dig",
      label: "Dig",
      arguments: ["example.com"],
      status: "completed" as const,
      resolvedCommand: "dig example.com",
    };
    let fireEvents!: () => void;
    mockCreateScan.mockImplementation((_missionId, _profileId, _target, onEvent) =>
      new Promise<ScanRun>((r) => {
        fireEvents = () => {
          onEvent({ type: "scan", scan: fixtureRun() });
          onEvent({ type: "step", step: doneStep });
          r(fixtureRun({ status: "completed", steps: [doneStep] }));
        };
      }),
    );

    const { result, rerender } = renderHook(({ missionId }) => useScans(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });

    let run!: Promise<void>;
    await act(async () => {
      run = result.current.runScan();
    });
    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchScans).toHaveBeenLastCalledWith("proj-2"));

    await act(async () => {
      fireEvents();
      await run;
    });

    expect(result.current.scans).toEqual([]);
    expect(result.current.run).toBeNull();
  });

  it("runScan() surfaces a failure", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);
    mockCreateScan.mockRejectedValue(new Error("scan failed"));

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });
    await act(async () => {
      await result.current.runScan();
    });

    expect(result.current.error).toBe("scan failed");
    expect(result.current.running).toBe(false);
  });

  it("cancel() calls cancelScan for the current run", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);
    mockCreateScan.mockImplementation(async (_missionId, _profileId, _target, onEvent) => {
      const running = fixtureRun();
      onEvent({ type: "scan", scan: running });
      return running;
    });
    mockCancelScan.mockResolvedValue(fixtureRun({ status: "cancelled" }));

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });
    await act(async () => {
      await result.current.runScan();
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(mockCancelScan).toHaveBeenCalledWith("proj-1", "scan-1");
  });

  it("cancel() is a no-op with no active run", async () => {
    mockFetchScanProfiles.mockResolvedValue([]);
    const { result } = renderHook(() => useScans(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.cancel();
    });

    expect(mockCancelScan).not.toHaveBeenCalled();
  });

  it("reset() clears run, live output, preview, and error", async () => {
    mockFetchScanProfiles.mockResolvedValue([fixtureProfile]);
    mockFetchScans.mockResolvedValue([]);
    mockPreviewScan.mockResolvedValue(fixturePreview);

    const { result } = renderHook(() => useScans("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runPreview("quick-recon", "example.com");
    });

    act(() => result.current.reset());

    expect(result.current.run).toBeNull();
    expect(result.current.liveOutput).toEqual([]);
    expect(result.current.preview).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
