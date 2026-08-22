import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportsView } from "./ReportsView";
import { useMissions } from "../hooks/useMissions";
import { useReports } from "../hooks/useReports";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
vi.mock("../hooks/useReports", () => ({ useReports: vi.fn() }));
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
vi.mock("./ReportsPanel", () => ({ ReportsPanel: () => <div data-testid="reports-panel" /> }));

const mockUseMissions = vi.mocked(useMissions);
const mockUseReports = vi.mocked(useReports);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1 };

describe("ReportsView", () => {
  it("prompts to select a mission before showing the reports panel", () => {
    mockUseMissions.mockReturnValue({
      missions: [mission],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseReports.mockReturnValue({
      reports: [],
      loading: false,
      generating: false,
      streamingText: "",
      error: null,
      refresh: vi.fn(),
      generate: vi.fn(),
      remove: vi.fn(),
      setStatus: vi.fn(),
    });

    render(<ReportsView />);
    expect(screen.getByText(/Select or create a mission/)).toBeInTheDocument();
    expect(screen.queryByTestId("reports-panel")).not.toBeInTheDocument();
  });

  it("shows the reports panel once a mission is selected", async () => {
    mockUseMissions.mockReturnValue({
      missions: [mission],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseReports.mockReturnValue({
      reports: [],
      loading: false,
      generating: false,
      streamingText: "",
      error: null,
      refresh: vi.fn(),
      generate: vi.fn(),
      remove: vi.fn(),
      setStatus: vi.fn(),
    });

    render(<ReportsView />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));
    expect(screen.getByTestId("reports-panel")).toBeInTheDocument();
  });
});
