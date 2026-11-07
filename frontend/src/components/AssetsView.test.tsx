import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssetsView } from "./AssetsView";
import { useAssets } from "../hooks/useAssets";
import type { Mission } from "../types/mission";
import type { Asset } from "../types/asset";

vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));


const mockUseAssets = vi.mocked(useAssets);

const mission: Mission = { id: "mission-1", name: "Mission A", notes: "", createdAt: 1 };

function fixtureAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    missionId: "mission-1",
    type: "domain",
    value: "example.com",
    status: "active",
    discoveredBy: "recon-agent",
    source: "agent",
    firstSeen: 1,
    lastSeen: 1,
    metadata: {},
    ...overrides,
  };
}

function setup(assets: Asset[]) {
  mockUseAssets.mockReturnValue({ assets, loading: false, error: null, refresh: vi.fn() });
}

describe("AssetsView", () => {
  it("prompts to create a mission before showing anything else", () => {
    setup([]);
    render(<AssetsView mission={null} />);
    expect(screen.getByText(/Create a mission/)).toBeInTheDocument();
  });

  it("shows an empty state when the selected mission has no assets yet", async () => {
    setup([]);
    render(<AssetsView mission={mission} />);
    expect(screen.getByText(/No assets yet/)).toBeInTheDocument();
  });

  it("groups assets by type, showing real status/discoveredBy fields", async () => {
    setup([
      fixtureAsset({ id: "a1", type: "domain", value: "example.com" }),
      fixtureAsset({ id: "a2", type: "subdomain", value: "api.example.com", status: "unverified", discoveredBy: "web-analyzer" }),
    ]);
    render(<AssetsView mission={mission} />);

    expect(screen.getByText("Domains (1)")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Subdomains (1)")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("web-analyzer")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
  });
});
