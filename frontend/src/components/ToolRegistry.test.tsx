import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolRegistry } from "./ToolRegistry";
import type { ExecToolWithStatus } from "../types/execTool";

function tool(overrides: Partial<ExecToolWithStatus>): ExecToolWithStatus {
  return {
    id: "nmap",
    name: "nmap",
    description: "Port scanner",
    category: "network",
    executable: "nmap",
    defaultArguments: [],
    timeout: 1000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "radar",
    availability: "available",
    ...overrides,
  };
}

const tools = [
  tool({}),
  tool({ id: "katana", name: "katana", description: "Web crawler", category: "web", executable: "katana", availability: "unavailable" }),
  tool({ id: "bash", name: "bash", description: "Run a shell command", category: "os", executable: "bash" }),
];

const names = () => [...new Set(screen.queryAllByText(/^(nmap|katana|bash)$/).map((el) => el.textContent))];

describe("ToolRegistry filters", () => {
  it("searches name and description", async () => {
    render(<ToolRegistry tools={tools} loading={false} error={null} />);
    await userEvent.setup().type(screen.getByLabelText("Search tools"), "crawl");
    expect(names()).toEqual(["katana"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
  });

  it("filters by category and by not installed", async () => {
    render(<ToolRegistry tools={tools} loading={false} error={null} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Category"), "os");
    expect(names()).toEqual(["bash"]);
    await user.selectOptions(screen.getByLabelText("Category"), "");
    await user.click(screen.getByLabelText("Not installed only"));
    expect(names()).toEqual(["katana"]);
  });

  it("says when nothing matches", async () => {
    render(<ToolRegistry tools={tools} loading={false} error={null} />);
    await userEvent.setup().type(screen.getByLabelText("Search tools"), "zzz");
    expect(screen.getByText("No tools match.")).toBeInTheDocument();
  });
});
