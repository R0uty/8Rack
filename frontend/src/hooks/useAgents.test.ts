import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgents } from "./useAgents";
import { fetchAgents, reloadAgents } from "../services/api";
import type { AgentWithStatus } from "../types/agent";

vi.mock("../services/api", () => ({ fetchAgents: vi.fn(), reloadAgents: vi.fn() }));

const mockFetchAgents = vi.mocked(fetchAgents);
const mockReloadAgents = vi.mocked(reloadAgents);

const fixtureAgent: AgentWithStatus = {
  id: "planner",
  name: "Planner",
  description: "",
  model: "test-model",
  systemPrompt: "",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 0,
  icon: "",
  color: "",
  enabled: true,
  status: "online",
};

describe("useAgents", () => {
  it("loads agents and warnings on mount", async () => {
    mockFetchAgents.mockResolvedValue({ agents: [fixtureAgent], warnings: [{ file: "bad.json", reason: "invalid JSON" }] });
    const { result } = renderHook(() => useAgents());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents).toEqual([fixtureAgent]);
    expect(result.current.warnings).toEqual([{ file: "bad.json", reason: "invalid JSON" }]);
    expect(mockReloadAgents).not.toHaveBeenCalled();
  });

  it("surfaces a load failure", async () => {
    mockFetchAgents.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAgents());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("refresh() calls reloadAgents (not fetchAgents) and replaces state", async () => {
    mockFetchAgents.mockResolvedValue({ agents: [], warnings: [] });
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockReloadAgents.mockResolvedValue({ agents: [fixtureAgent], warnings: [] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(mockReloadAgents).toHaveBeenCalledTimes(1);
    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
    expect(result.current.agents).toEqual([fixtureAgent]);
  });

  it("a refresh failure reports a reload-specific message", async () => {
    mockFetchAgents.mockResolvedValue({ agents: [], warnings: [] });
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockReloadAgents.mockRejectedValue(new Error("disk error"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("disk error");
  });
});
