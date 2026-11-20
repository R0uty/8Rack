import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGED_DEBOUNCE_MS, publishChanged, publishMission, subscribeMission } from "./missionEvents.js";
import type { MissionStreamEvent } from "../types/missionRun.js";

describe("missionEvents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers events only to the mission's own subscribers, until they unsubscribe", () => {
    const a: MissionStreamEvent[] = [];
    const b: MissionStreamEvent[] = [];
    const offA = subscribeMission("m-a", (e) => a.push(e));
    const offB = subscribeMission("m-b", (e) => b.push(e));

    publishMission("m-a", { type: "chunk", content: "x" });
    offA();
    publishMission("m-a", { type: "chunk", content: "y" });

    expect(a).toEqual([{ type: "chunk", content: "x" }]);
    expect(b).toEqual([]);
    offB();
  });

  it("gathers a burst of writes to one file into a single changed event", () => {
    const events: MissionStreamEvent[] = [];
    const off = subscribeMission("m-c", (e) => events.push(e));

    for (let i = 0; i < 50; i++) publishChanged("m-c", "findings.json");
    publishChanged("m-c", "work-orders.json");
    vi.advanceTimersByTime(CHANGED_DEBOUNCE_MS);

    expect(events).toEqual([
      { type: "changed", resource: "findings" },
      { type: "changed", resource: "work-orders" },
    ]);
    off();
  });

  it("keeps going when one subscriber throws", () => {
    const seen: MissionStreamEvent[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off1 = subscribeMission("m-d", () => {
      throw new Error("boom");
    });
    const off2 = subscribeMission("m-d", (e) => seen.push(e));
    publishMission("m-d", { type: "chunk", content: "z" });
    expect(seen).toHaveLength(1);
    off1();
    off2();
  });
});
