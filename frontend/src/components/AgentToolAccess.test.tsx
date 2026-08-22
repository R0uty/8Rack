import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentToolAccess } from "./AgentToolAccess";
import type { ExecToolWithStatus } from "../types/execTool";

function fixtureTool(overrides: Partial<ExecToolWithStatus> = {}): ExecToolWithStatus {
  return {
    id: "nmap",
    name: "Nmap",
    description: "",
    category: "recon",
    executable: "nmap",
    defaultArguments: [],
    timeout: 1000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "",
    availability: "available",
    ...overrides,
  };
}

describe("AgentToolAccess", () => {
  it("shows unrestricted when execTools is undefined", () => {
    render(<AgentToolAccess agent={{ execTools: undefined }} tools={[fixtureTool()]} />);
    expect(screen.getByText(/Unrestricted/)).toBeInTheDocument();
  });

  it("splits tools into allowed/restricted by the agent's execTools allowlist", () => {
    render(
      <AgentToolAccess
        agent={{ execTools: ["nmap"] }}
        tools={[fixtureTool({ id: "nmap", name: "Nmap" }), fixtureTool({ id: "bash", name: "Bash" })]}
      />,
    );
    expect(screen.getByText("Allowed (1)")).toBeInTheDocument();
    expect(screen.getByText("Nmap")).toBeInTheDocument();
    expect(screen.getByText("Restricted (1)")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("treats an empty execTools array as no tools allowed", () => {
    render(<AgentToolAccess agent={{ execTools: [] }} tools={[fixtureTool()]} />);
    expect(screen.getByText("Allowed (0)")).toBeInTheDocument();
    expect(screen.getByText("Restricted (1)")).toBeInTheDocument();
  });
});
