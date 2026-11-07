import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useModels } from "./useModels";
import { fetchModels } from "../services/modelsApi";
import type { OllamaModel } from "../types/ollama";

vi.mock("../services/modelsApi", () => ({ fetchModels: vi.fn() }));

const mockFetchModels = vi.mocked(fetchModels);

const fixtureModel: OllamaModel = {
  name: "qwen2.5-coder:7b",
  model: "qwen2.5-coder:7b",
  modified_at: "",
  size: 0,
  digest: "",
};

describe("useModels", () => {
  it("loads models on mount", async () => {
    mockFetchModels.mockResolvedValue([fixtureModel]);
    const { result } = renderHook(() => useModels());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.models).toEqual([fixtureModel]);
    expect(result.current.error).toBeNull();
  });

  it("hides embedding-only models from `models` but keeps them in `allModels`", async () => {
    const embedModel: OllamaModel = {
      name: "nomic-embed-text:latest",
      model: "nomic-embed-text:latest",
      modified_at: "",
      size: 0,
      digest: "",
      capabilities: ["embedding"],
    };
    mockFetchModels.mockResolvedValue([embedModel, fixtureModel]);
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.models).toEqual([fixtureModel]);
    expect(result.current.allModels).toEqual([embedModel, fixtureModel]);
  });

  it("surfaces a load failure", async () => {
    mockFetchModels.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.models).toEqual([]);
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    mockFetchModels.mockRejectedValue("nope");
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Failed to load models");
  });

  it("refresh() re-fetches and clears a prior error", async () => {
    mockFetchModels.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.error).toBe("boom"));

    mockFetchModels.mockResolvedValueOnce([fixtureModel]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.models).toEqual([fixtureModel]);
    expect(mockFetchModels).toHaveBeenCalledTimes(2);
  });
});
