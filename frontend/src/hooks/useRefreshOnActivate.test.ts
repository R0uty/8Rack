import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRefreshOnActivate } from "./useRefreshOnActivate";

describe("useRefreshOnActivate", () => {
  it("refreshes only when a hidden view becomes active again", () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ active }) => useRefreshOnActivate(active, refresh), {
      initialProps: { active: true },
    });
    expect(refresh).not.toHaveBeenCalled(); // the view's own hooks already fetched on mount

    rerender({ active: false });
    expect(refresh).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
