import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMcpServers } from "./useMcpServers";
import { fetchMcpServers, refreshMcpServers } from "../services/mcpApi";
import type { McpServerStatus } from "../types/mcp";

vi.mock("../services/mcpApi", () => ({ fetchMcpServers: vi.fn(), refreshMcpServers: vi.fn() }));

const mockFetch = vi.mocked(fetchMcpServers);
const mockRefresh = vi.mocked(refreshMcpServers);

function server(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { id: "tools", url: "https://scan.example/mcp", knowledgeBase: false, state: "online", tools: [], skippedTools: 0, checkedAt: 1, ...overrides };
}

describe("useMcpServers", () => {
  it("loads servers on mount without checking again when they're already checked", async () => {
    mockRefresh.mockClear();
    mockFetch.mockResolvedValue([server()]);
    const { result } = renderHook(() => useMcpServers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.servers).toEqual([server()]);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("waits for the backend's first check when a server is still being checked", async () => {
    mockFetch.mockResolvedValue([server({ state: "checking", checkedAt: null })]);
    mockRefresh.mockResolvedValue([server()]);
    const { result } = renderHook(() => useMcpServers());

    await waitFor(() => expect(result.current.servers?.[0].state).toBe("online"));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("surfaces a load failure", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useMcpServers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("check() reports a failure", async () => {
    mockFetch.mockResolvedValue([server()]);
    const { result } = renderHook(() => useMcpServers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockRefresh.mockRejectedValue(new Error("backend down"));
    await act(async () => {
      await result.current.check();
    });

    expect(result.current.error).toBe("backend down");
    expect(result.current.checking).toBe(false);
  });
});
