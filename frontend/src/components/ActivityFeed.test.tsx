import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityFeed } from "./ActivityFeed";
import type { MissionEvent } from "../types/missionEvent";

function fixtureEvent(overrides: Partial<MissionEvent> = {}): MissionEvent {
  return {
    id: "event-1",
    missionId: "proj-1",
    type: "asset_discovered",
    summary: "domain discovered: example.com",
    createdAt: 1000,
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("shows an empty state with no events", () => {
    render(<ActivityFeed events={[]} loading={false} error={null} />);
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
  });

  it("shows the error message instead of the feed when error is set", () => {
    render(<ActivityFeed events={[]} loading={false} error="boom" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders events, newest first as given", () => {
    render(
      <ActivityFeed
        events={[
          fixtureEvent({ id: "e2", createdAt: 2000, summary: "Work order started for recon-agent" }),
          fixtureEvent({ id: "e1", createdAt: 1000, summary: "domain discovered: example.com" }),
        ]}
        loading={false}
        error={null}
      />,
    );

    const rows = screen.getAllByText(/Work order started for recon-agent|domain discovered: example\.com/);
    expect(rows[0]).toHaveTextContent("Work order started for recon-agent");
    expect(rows[1]).toHaveTextContent("domain discovered: example.com");
  });

  it("shows a scope_blocked event with a critical tone label", () => {
    render(
      <ActivityFeed
        events={[fixtureEvent({ type: "scope_blocked", summary: "Execution blocked - target outside scope" })]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText("Execution blocked - target outside scope")).toBeInTheDocument();
    expect(screen.getByText("scope")).toBeInTheDocument();
  });
});
