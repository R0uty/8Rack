import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpServersPanel } from "./McpServersPanel";
import { useMcpServers } from "../hooks/useMcpServers";
import type { McpServerStatus } from "../types/mcp";

vi.mock("../hooks/useMcpServers", () => ({ useMcpServers: vi.fn() }));

function setup(servers: McpServerStatus[] | null, overrides: Partial<ReturnType<typeof useMcpServers>> = {}) {
  const check = vi.fn();
  vi.mocked(useMcpServers).mockReturnValue({ servers, loading: false, checking: false, error: null, check, ...overrides });
  return { check };
}

function server(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { id: "tools", url: "https://scan.example/mcp", knowledgeBase: false, state: "online", tools: [], skippedTools: 0, checkedAt: Date.now(), ...overrides };
}

describe("McpServersPanel", () => {
  it("explains how to add a server when none are configured", () => {
    setup([]);
    render(<McpServersPanel />);
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();
    expect(screen.getByText(/MCP_TOKEN_<ID>/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("lists an online server's tools and says agents can't use them yet", () => {
    setup([server({ tools: [{ name: "nmap", description: "Port scanner" }, { name: "httpx", description: "" }], skippedTools: 1 })]);
    render(<McpServersPanel />);

    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("nmap")).toBeInTheDocument();
    expect(screen.getByText(/Port scanner/)).toBeInTheDocument();
    expect(screen.getByText(/2 tools · 1 not listed/)).toBeInTheDocument();
    expect(screen.getByText(/Agents can't call them directly yet/)).toBeInTheDocument();
    expect(screen.queryByText("knowledge base")).not.toBeInTheDocument();
  });

  it("marks the server that serves the knowledge base", () => {
    setup([server({ id: "rag", knowledgeBase: true })]);
    render(<McpServersPanel />);
    expect(screen.getByText("knowledge base")).toBeInTheDocument();
  });

  it("shows why a server failed or is misconfigured", () => {
    setup([
      server({ state: "error", error: "The server rejected the token (HTTP 401). Check MCP_TOKEN_TOOLS." }),
      server({ id: "rag", url: "", state: "misconfigured", error: "MCP_TOKEN_RAG is not set", checkedAt: null }),
    ]);
    render(<McpServersPanel />);

    expect(screen.getByText(/rejected the token/)).toBeInTheDocument();
    expect(screen.getByText("misconfigured")).toBeInTheDocument();
    expect(screen.getByText("MCP_TOKEN_RAG is not set")).toBeInTheDocument();
  });

  it("checks the servers again on request", async () => {
    const { check } = setup([server()]);
    render(<McpServersPanel />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));

    expect(check).toHaveBeenCalled();
  });

  it("disables the button while a check runs", () => {
    setup([server({ state: "checking", checkedAt: null })], { checking: true });
    render(<McpServersPanel />);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});
