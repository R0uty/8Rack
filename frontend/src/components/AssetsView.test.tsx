import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssetsView } from "./AssetsView";
import type { Finding } from "../types/finding";

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    projectId: "proj-1",
    type: "port",
    severity: "info",
    title: "Port 80/tcp open",
    description: "",
    source: "scanner",
    tool: "nmap",
    confidence: 0.9,
    target: "example.com",
    value: "80/tcp",
    metadata: {},
    evidence: [],
    tags: [],
    status: "potential",
    history: [],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("AssetsView", () => {
  it("shows an empty state when there are no assets yet", () => {
    render(<AssetsView findings={[]} />);
    expect(screen.getByText(/No assets discovered yet/)).toBeInTheDocument();
  });

  it("groups findings into asset categories by type", () => {
    render(
      <AssetsView
        findings={[
          fixtureFinding({ id: "f1", type: "domain", value: "example.com", target: "example.com" }),
          fixtureFinding({ id: "f2", type: "subdomain", value: "api.example.com", target: "api.example.com" }),
          fixtureFinding({ id: "f3", type: "technology", value: "nginx", target: "example.com" }),
        ]}
      />,
    );

    expect(screen.getByText("Domains (1)")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Subdomains (1)")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("Technologies (1)")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
  });

  it("deduplicates findings with the same value within a category, showing a count", () => {
    // A non-IP target so this doesn't also populate the IP addresses group, which would produce a
    // second, ambiguous "×2" elsewhere in the document.
    render(
      <AssetsView
        findings={[
          fixtureFinding({ id: "f1", type: "port", value: "80/tcp", target: "example.com" }),
          fixtureFinding({ id: "f2", type: "port", value: "80/tcp", target: "example.com" }),
        ]}
      />,
    );

    expect(screen.getByText("Ports (1)")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  it("derives an IP addresses group from any finding's target that looks like an IPv4 address", () => {
    render(
      <AssetsView
        findings={[
          fixtureFinding({ id: "f1", type: "port", value: "80/tcp", target: "10.0.0.5" }),
          fixtureFinding({ id: "f2", type: "port", value: "443/tcp", target: "10.0.0.5" }),
          fixtureFinding({ id: "f3", type: "domain", value: "example.com", target: "example.com" }),
        ]}
      />,
    );

    expect(screen.getByText("IP addresses (1)")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
  });

  it("omits categories that have no findings", () => {
    render(<AssetsView findings={[fixtureFinding({ type: "domain", value: "example.com" })]} />);
    expect(screen.queryByText(/^Ports/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^APIs/)).not.toBeInTheDocument();
  });

  it("ignores finding types that aren't asset categories (e.g. potential_vulnerability)", () => {
    render(<AssetsView findings={[fixtureFinding({ type: "potential_vulnerability", value: "SQLi" })]} />);
    expect(screen.getByText(/No assets discovered yet/)).toBeInTheDocument();
  });
});
