import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionsView } from "./MissionsView";
import { useMissions } from "../hooks/useMissions";
import { useActivity } from "../hooks/useActivity";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
vi.mock("../hooks/useActivity", () => ({ useActivity: vi.fn() }));
vi.mock("./MissionPanel", () => ({
  MissionPanel: ({ missions, onSelect }: { missions: Mission[]; onSelect: (m: Mission) => void }) => (
    <div>
      {missions.map((m) => (
        <button key={m.id} onClick={() => onSelect(m)}>
          {m.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => <div data-testid="activity-feed" /> }));

const mockUseMissions = vi.mocked(useMissions);
const mockUseActivity = vi.mocked(useActivity);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1 };

describe("MissionsView", () => {
  it("does not show the activity timeline or 'open factory' action until a mission is selected", () => {
    mockUseMissions.mockReturnValue({
      missions: [mission],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseActivity.mockReturnValue({ events: [], loading: false, error: null, refresh: vi.fn() });

    render(<MissionsView onOpenFactory={vi.fn()} />);

    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Factory Dashboard" })).not.toBeInTheDocument();
  });

  it("shows the mission's activity timeline and lets you jump to the Factory Dashboard once selected", async () => {
    mockUseMissions.mockReturnValue({
      missions: [mission],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseActivity.mockReturnValue({ events: [], loading: false, error: null, refresh: vi.fn() });
    const onOpenFactory = vi.fn();

    render(<MissionsView onOpenFactory={onOpenFactory} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));

    expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Factory Dashboard" }));
    expect(onOpenFactory).toHaveBeenCalled();
  });
});
