import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  it("defaults to dark when nothing is stored", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("restores a previously stored theme", () => {
    localStorage.setItem("8rack:theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("ignores an invalid stored value", () => {
    localStorage.setItem("8rack:theme", "purple");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("toggle() flips between dark and light and persists", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("8rack:theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
  });

  it("setTheme sets an explicit value", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("light"));
    expect(result.current.theme).toBe("light");
  });
});
