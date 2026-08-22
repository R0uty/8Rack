import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolsView } from "./ToolsView";
import { useMissions } from "../hooks/useMissions";
import { useTools } from "../hooks/useTools";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
vi.mock("../hooks/useTools", () => ({ useTools: vi.fn() }));
vi.mock("./MissionPanel", () => ({ MissionPanel: () => <div data-testid="mission-panel" /> }));
vi.mock("./ToolRegistry", () => ({ ToolRegistry: () => <div data-testid="tool-registry" /> }));
vi.mock("./ExecutionHistoryPanel", () => ({ ExecutionHistoryPanel: () => <div data-testid="execution-history" /> }));

const mockUseMissions = vi.mocked(useMissions);
const mockUseTools = vi.mocked(useTools);

describe("ToolsView", () => {
  it("renders the mission selector, tool registry, and execution history together", () => {
    mockUseMissions.mockReturnValue({
      missions: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseTools.mockReturnValue({ tools: [], executions: [], loading: false, error: null, refresh: vi.fn(), toggleTool: vi.fn() });

    render(<ToolsView agents={[]} />);

    expect(screen.getByTestId("mission-panel")).toBeInTheDocument();
    expect(screen.getByTestId("tool-registry")).toBeInTheDocument();
    expect(screen.getByTestId("execution-history")).toBeInTheDocument();
  });
});
