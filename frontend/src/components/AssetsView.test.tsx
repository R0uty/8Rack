import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssetsView } from "./AssetsView";
import { useMissions } from "../hooks/useMissions";
import { useAssets } from "../hooks/useAssets";
import type { Mission } from "../types/mission";
import type { Asset } from "../types/asset";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));

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

const mockUseMissions = vi.mocked(useMissions);
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
  mockUseMissions.mockReturnValue({
    missions: [mission],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  });
  mockUseAssets.mockReturnValue({ assets, loading: false, error: null, refresh: vi.fn() });
}

describe("AssetsView", () => {
  it("prompts to select a mission before showing anything else", () => {
    setup([]);
    render(<AssetsView />);
    expect(screen.getByText(/Select or create a mission/)).toBeInTheDocument();
  });

  it("shows an empty state when the selected mission has no assets yet", async () => {
    setup([]);
    render(<AssetsView />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));
    expect(screen.getByText(/No assets discovered yet/)).toBeInTheDocument();
  });

  it("groups assets by type, showing real status/discoveredBy fields", async () => {
    setup([
      fixtureAsset({ id: "a1", type: "domain", value: "example.com" }),
      fixtureAsset({ id: "a2", type: "subdomain", value: "api.example.com", status: "unverified", discoveredBy: "web-analyzer" }),
    ]);
    render(<AssetsView />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mission A" }));

    expect(screen.getByText("Domains (1)")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Subdomains (1)")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("web-analyzer")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
  });
});
