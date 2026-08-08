import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTools } from "./useTools";
import { fetchExecutions, fetchTools, setToolEnabled } from "../services/toolsApi";
import type { ExecToolWithStatus, ExecutionRecord } from "../types/execTool";

vi.mock("../services/toolsApi", () => ({
  fetchTools: vi.fn(),
  fetchExecutions: vi.fn(),
  setToolEnabled: vi.fn(),
}));

const mockFetchTools = vi.mocked(fetchTools);
const mockFetchExecutions = vi.mocked(fetchExecutions);
const mockSetToolEnabled = vi.mocked(setToolEnabled);

const fixtureTool: ExecToolWithStatus = {
  id: "nmap",
  name: "nmap",
  description: "",
  category: "recon",
  executable: "nmap",
  defaultArguments: [],
  timeout: 60000,
  enabled: true,
  requiresConfirmation: true,
  parser: "text",
  icon: "",
  availability: "available",
};

const fixtureExecution: ExecutionRecord = {
  id: "exec-1",
  toolId: "nmap",
  arguments: [],
  resolvedCommand: "nmap",
  cwd: "/",
  status: "completed",
  createdAt: 0,
};

describe("useTools", () => {
  it("loads tools and skips execution history when projectId is null", async () => {
    mockFetchTools.mockResolvedValue([fixtureTool]);
    const { result } = renderHook(() => useTools(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tools).toEqual([fixtureTool]);
    expect(result.current.executions).toEqual([]);
    expect(mockFetchExecutions).not.toHaveBeenCalled();
  });

  it("loads execution history scoped to a projectId", async () => {
    mockFetchTools.mockResolvedValue([fixtureTool]);
    mockFetchExecutions.mockResolvedValue([fixtureExecution]);
    const { result } = renderHook(() => useTools("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchExecutions).toHaveBeenCalledWith("proj-1");
    expect(result.current.executions).toEqual([fixtureExecution]);
  });

  it("re-fetches when projectId changes", async () => {
    mockFetchTools.mockResolvedValue([fixtureTool]);
    mockFetchExecutions.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ projectId }) => useTools(projectId), {
      initialProps: { projectId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchExecutions).toHaveBeenCalledWith("proj-1");

    rerender({ projectId: "proj-2" });
    await waitFor(() => expect(mockFetchExecutions).toHaveBeenLastCalledWith("proj-2"));
  });

  it("surfaces a load failure", async () => {
    mockFetchTools.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useTools(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("toggleTool() calls the backend and reconciles the tool from its response", async () => {
    mockFetchTools.mockResolvedValue([fixtureTool]);
    const disabled: ExecToolWithStatus = { ...fixtureTool, enabled: false };
    mockSetToolEnabled.mockResolvedValue(disabled);
    const { result } = renderHook(() => useTools(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleTool("nmap", false);
    });

    expect(mockSetToolEnabled).toHaveBeenCalledWith("nmap", false);
    expect(result.current.tools).toEqual([disabled]);
  });
});
