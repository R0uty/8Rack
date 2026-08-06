import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBookmarks } from "./useBookmarks";

const STORAGE_KEY = "8rack:bookmarked-executions";

describe("useBookmarks", () => {
  it("starts empty when nothing is stored", () => {
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.bookmarked.size).toBe(0);
    expect(result.current.isBookmarked("exec-1")).toBe(false);
  });

  it("restores previously stored ids", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["exec-1", "exec-2"]));
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.isBookmarked("exec-1")).toBe(true);
    expect(result.current.isBookmarked("exec-2")).toBe(true);
    expect(result.current.isBookmarked("exec-3")).toBe(false);
  });

  it("falls back to empty on corrupt stored JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.bookmarked.size).toBe(0);
  });

  it("toggle() adds then removes an id, persisting each change", () => {
    const { result } = renderHook(() => useBookmarks());

    act(() => result.current.toggle("exec-1"));
    expect(result.current.isBookmarked("exec-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["exec-1"]);

    act(() => result.current.toggle("exec-1"));
    expect(result.current.isBookmarked("exec-1")).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
  });

  it("toggle() on one id doesn't disturb others", () => {
    const { result } = renderHook(() => useBookmarks());

    act(() => result.current.toggle("exec-1"));
    act(() => result.current.toggle("exec-2"));
    act(() => result.current.toggle("exec-1"));

    expect(result.current.isBookmarked("exec-1")).toBe(false);
    expect(result.current.isBookmarked("exec-2")).toBe(true);
  });
});
