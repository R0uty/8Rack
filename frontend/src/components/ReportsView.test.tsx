import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportsView } from "./ReportsView";
import { useReports } from "../hooks/useReports";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useReports", () => ({ useReports: vi.fn() }));
vi.mock("./ReportsPanel", () => ({ ReportsPanel: () => <div data-testid="reports-panel" /> }));

const mockUseReports = vi.mocked(useReports);

const mission: Mission = { id: "m1", name: "Mission A", notes: "", createdAt: 1 };

describe("ReportsView", () => {
  it("prompts to create a mission before showing the reports panel", () => {
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

    render(<ReportsView mission={null} />);
    expect(screen.getByText(/Create a mission/)).toBeInTheDocument();
    expect(screen.queryByTestId("reports-panel")).not.toBeInTheDocument();
  });

  it("shows the reports panel once a mission is selected", () => {
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

    render(<ReportsView mission={mission} />);
    expect(screen.getByTestId("reports-panel")).toBeInTheDocument();
  });
});
