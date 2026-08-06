import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSettings } from "./useSettings";
import { DEFAULT_SETTINGS } from "../types/settings";

const STORAGE_KEY = "8rack:settings";

describe("useSettings", () => {
  it("defaults when nothing is stored", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("merges stored settings over defaults, filling in any missing fields", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ temperature: 0.2 }));
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual({ ...DEFAULT_SETTINGS, temperature: 0.2 });
  });

  it("falls back to defaults on corrupt stored JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("update() merges a partial patch and persists it", () => {
    const { result } = renderHook(() => useSettings());

    act(() => result.current.update({ temperature: 0.3, keepAlive: "10m" }));

    expect(result.current.settings).toEqual({ ...DEFAULT_SETTINGS, temperature: 0.3, keepAlive: "10m" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(result.current.settings);
  });

  it("reset() restores defaults", () => {
    const { result } = renderHook(() => useSettings());

    act(() => result.current.update({ temperature: 0.1 }));
    expect(result.current.settings.temperature).toBe(0.1);

    act(() => result.current.reset());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });
});
