import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useReports } from "./useReports";
import { createReport, deleteReport, fetchReports } from "../services/reportsApi";
import type { Report } from "../types/report";

vi.mock("../services/reportsApi", () => ({
  fetchReports: vi.fn(),
  createReport: vi.fn(),
  deleteReport: vi.fn(),
}));

const mockFetchReports = vi.mocked(fetchReports);
const mockCreateReport = vi.mocked(createReport);
const mockDeleteReport = vi.mocked(deleteReport);

function fixtureReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "report-1",
    missionId: "proj-1",
    title: "My Report",
    findingIds: ["finding-1"],
    agentId: "report-writer",
    model: "test-model",
    markdown: "## Executive Summary\nAll good.",
    sections: [{ heading: "Executive Summary", content: "All good." }],
    status: "ai_generated",
    createdAt: 0,
    ...overrides,
  };
}

describe("useReports", () => {
  it("skips fetching and stays empty when missionId is null", async () => {
    const { result } = renderHook(() => useReports(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.reports).toEqual([]);
    expect(mockFetchReports).not.toHaveBeenCalled();
  });

  it("loads report history scoped to a missionId", async () => {
    mockFetchReports.mockResolvedValue([fixtureReport()]);
    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchReports).toHaveBeenCalledWith("proj-1");
    expect(result.current.reports).toEqual([fixtureReport()]);
  });

  it("re-fetches when missionId changes", async () => {
    mockFetchReports.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ missionId }) => useReports(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchReports).toHaveBeenCalledWith("proj-1");

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchReports).toHaveBeenLastCalledWith("proj-2"));
  });

  it("surfaces a load failure", async () => {
    mockFetchReports.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("generate() streams chunks into streamingText, then settles into reports and clears streamingText", async () => {
    mockFetchReports.mockResolvedValue([]);
    let onChunkRef!: (c: string) => void;
    mockCreateReport.mockImplementation(async (_missionId, _title, _findingIds, onChunk) => {
      onChunkRef = onChunk;
      onChunk("## Executive Summary\n");
      return fixtureReport();
    });

    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Report | undefined;
    await act(async () => {
      created = await result.current.generate("My Report", ["finding-1"]);
    });

    expect(mockCreateReport).toHaveBeenCalledWith("proj-1", "My Report", ["finding-1"], expect.any(Function));
    expect(created).toEqual(fixtureReport());
    expect(result.current.reports).toEqual([fixtureReport()]);
    expect(result.current.streamingText).toBe("");
    expect(result.current.generating).toBe(false);
    expect(onChunkRef).toBeDefined();
  });

  it("generate() is a no-op without a missionId or with no findings selected", async () => {
    const { result } = renderHook(() => useReports(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.generate("Title", []);
    });
    expect(mockCreateReport).not.toHaveBeenCalled();
  });

  it("generate() surfaces a failure", async () => {
    mockFetchReports.mockResolvedValue([]);
    mockCreateReport.mockRejectedValue(new Error("generation failed"));

    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.generate("My Report", ["finding-1"]);
    });

    expect(result.current.error).toBe("generation failed");
    expect(result.current.generating).toBe(false);
  });

  it("remove() deletes a report and drops it from state", async () => {
    mockFetchReports.mockResolvedValue([fixtureReport()]);
    mockDeleteReport.mockResolvedValue(undefined);

    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.reports).toHaveLength(1));

    await act(async () => {
      await result.current.remove("report-1");
    });

    expect(mockDeleteReport).toHaveBeenCalledWith("proj-1", "report-1");
    expect(result.current.reports).toEqual([]);
  });

  it("remove() surfaces a failure and keeps the report in state", async () => {
    mockFetchReports.mockResolvedValue([fixtureReport()]);
    mockDeleteReport.mockRejectedValue(new Error("delete failed"));

    const { result } = renderHook(() => useReports("proj-1"));
    await waitFor(() => expect(result.current.reports).toHaveLength(1));

    await act(async () => {
      await result.current.remove("report-1");
    });

    expect(result.current.error).toBe("delete failed");
    expect(result.current.reports).toHaveLength(1);
  });
});
