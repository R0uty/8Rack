import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSelectedMission } from "./useSelectedMission";
import type { Mission } from "../types/mission";

const a: Mission = { id: "a", name: "A", notes: "", createdAt: 1 };
const b: Mission = { id: "b", name: "B", notes: "", createdAt: 2 };

describe("useSelectedMission", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the first mission, and null with none", () => {
    expect(renderHook(() => useSelectedMission([a, b])).result.current.mission).toBe(a);
    expect(renderHook(() => useSelectedMission([])).result.current.mission).toBeNull();
  });

  it("remembers the selection across a remount", () => {
    const first = renderHook(() => useSelectedMission([a, b]));
    act(() => first.result.current.select("b"));
    expect(first.result.current.mission).toBe(b);
    first.unmount();

    expect(renderHook(() => useSelectedMission([a, b])).result.current.mission).toBe(b);
  });

  it("falls through to the next mission once the selected one is deleted", () => {
    const { result, rerender } = renderHook(({ missions }) => useSelectedMission(missions), {
      initialProps: { missions: [a, b] },
    });
    act(() => result.current.select("b"));
    rerender({ missions: [a] });
    expect(result.current.mission).toBe(a);
  });
});
