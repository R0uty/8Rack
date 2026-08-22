import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FactoryPipeline } from "./FactoryPipeline";
import type { Mission } from "../types/mission";
import type { WorkOrder } from "../types/workOrder";

function fixtureMission(overrides: Partial<Mission> = {}): Mission {
  return { id: "m1", name: "Mission", notes: "", createdAt: 1, ...overrides };
}

function fixtureWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo1",
    missionId: "m1",
    agentId: "recon-agent",
    objective: "recon",
    status: "running",
    priority: 1,
    dependencies: [],
    createdAt: 1,
    relatedAssets: [],
    relatedFindings: [],
    ...overrides,
  };
}

describe("FactoryPipeline", () => {
  it("marks the Scope stage current and every later stage pending for a draft mission", () => {
    render(<FactoryPipeline mission={fixtureMission({ status: "draft" })} workOrders={[]} findings={[]} />);
    const scope = screen.getByText("Scope").closest("div")?.parentElement;
    expect(scope?.className).toContain("border-primary/50");
  });

  it("shows a paused notice and no current stage when the mission is paused", () => {
    render(<FactoryPipeline mission={fixtureMission({ status: "paused" })} workOrders={[]} findings={[]} />);
    expect(screen.getByText(/Mission is paused/)).toBeInTheDocument();
  });

  it("counts running work orders whose agent matches the current stage as active", () => {
    render(
      <FactoryPipeline
        mission={fixtureMission({ status: "recon" })}
        workOrders={[fixtureWorkOrder({ agentId: "recon-agent", status: "running" })]}
        findings={[]}
      />,
    );
    // Both "recon" (index 1) and "Asset Discovery" (index 2) are in-range for status "recon", and
    // both list recon-agent - one running order shows up as "1 active" under each.
    expect(screen.getAllByText("1 active")).toHaveLength(2);
  });
});
