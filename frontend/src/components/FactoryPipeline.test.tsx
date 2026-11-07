import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FactoryPipeline } from "./FactoryPipeline";
import type { Mission } from "../types/mission";

function fixtureMission(overrides: Partial<Mission> = {}): Mission {
  return { id: "m1", name: "Mission", notes: "", createdAt: 1, ...overrides };
}

function current() {
  return document.querySelector('[aria-current="step"]')?.textContent;
}

describe("FactoryPipeline", () => {
  it("marks Scope current for a draft mission, and for one with no status yet", () => {
    const { rerender } = render(<FactoryPipeline mission={fixtureMission({ status: "draft" })} />);
    expect(current()).toBe("Scope");
    rerender(<FactoryPipeline mission={fixtureMission()} />);
    expect(current()).toBe("Scope");
  });

  it("follows the mission's real status", () => {
    render(<FactoryPipeline mission={fixtureMission({ status: "validating" })} />);
    expect(current()).toBe("Validate");
  });

  it("has no current stage once completed", () => {
    render(<FactoryPipeline mission={fixtureMission({ status: "completed" })} />);
    expect(current()).toBeUndefined();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("says so when the mission is paused, rather than implying a stage", () => {
    render(<FactoryPipeline mission={fixtureMission({ status: "paused" })} />);
    expect(current()).toBeUndefined();
    expect(screen.getByText(/This mission is paused/)).toBeInTheDocument();
  });
});
