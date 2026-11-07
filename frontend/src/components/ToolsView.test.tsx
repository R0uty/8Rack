import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolsView } from "./ToolsView";
import { useTools } from "../hooks/useTools";

vi.mock("../hooks/useTools", () => ({ useTools: vi.fn() }));
vi.mock("./ToolRegistry", () => ({ ToolRegistry: () => <div data-testid="tool-registry" /> }));
vi.mock("./ExecutionHistoryPanel", () => ({ ExecutionHistoryPanel: () => <div data-testid="execution-history" /> }));
vi.mock("./KnowledgeBasePanel", () => ({ KnowledgeBasePanel: () => <div data-testid="knowledge-base" /> }));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => <div data-testid="mcp-servers" /> }));
vi.mock("./ScannerPanel", () => ({ ScannerPanel: () => <div data-testid="scanner-panel" /> }));

const mission = { id: "m1", name: "Test Mission", notes: "", createdAt: 1 };

function setup() {
  vi.mocked(useTools).mockReturnValue({ tools: [], executions: [], loading: false, error: null, refresh: vi.fn(), toggleTool: vi.fn() });
}

describe("ToolsView", () => {
  it("opens on Scans and shows one tab at a time", async () => {
    setup();
    render(<ToolsView agents={[]} mission={mission} />);
    expect(screen.getByTestId("scanner-panel")).toBeVisible();
    expect(screen.getByTestId("tool-registry").parentElement).toHaveClass("hidden");

    await userEvent.setup().click(screen.getByRole("button", { name: "Registry" }));

    expect(screen.getByTestId("tool-registry").parentElement).not.toHaveClass("hidden");
    expect(screen.getByTestId("scanner-panel").parentElement).toHaveClass("hidden");
  });

  it("keeps a running scan mounted while another tab is open", async () => {
    setup();
    render(<ToolsView agents={[]} mission={mission} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByTestId("scanner-panel")).toBeInTheDocument();
  });

  it("still lists tools and the knowledge base with no mission, which aren't mission-scoped", () => {
    setup();
    render(<ToolsView agents={[]} mission={null} />);
    expect(screen.getByTestId("tool-registry")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-base")).toBeInTheDocument();
    expect(screen.queryByTestId("scanner-panel")).not.toBeInTheDocument();
  });
});
