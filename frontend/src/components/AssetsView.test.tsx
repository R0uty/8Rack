import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAsset, deleteAsset, setAssetStatus } from "../services/assetsApi";
import { updateMission } from "../services/missionsApi";
import { AppNavContext } from "../lib/appNav";
import { AssetsView } from "./AssetsView";
import { useAssets } from "../hooks/useAssets";
import type { Mission } from "../types/mission";
import type { Asset } from "../types/asset";

vi.mock("../hooks/useAssets", () => ({ useAssets: vi.fn() }));
vi.mock("../hooks/useWorkOrders", () => ({ useWorkOrders: vi.fn(() => ({ create: vi.fn(), start: vi.fn() })) }));
vi.mock("../services/assetsApi", () => ({ createAsset: vi.fn(), deleteAsset: vi.fn(), setAssetStatus: vi.fn() }));
vi.mock("../services/missionsApi", () => ({ updateMission: vi.fn() }));


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
  const refresh = vi.fn();
  mockUseAssets.mockReturnValue({ assets, loading: false, error: null, refresh });
  return { refresh };
}

beforeEach(() => vi.clearAllMocks());

describe("AssetsView", () => {
  it("prompts to create a mission before showing anything else", () => {
    setup([]);
    render(<AssetsView mission={null} />);
    expect(screen.getByText(/No mission selected/)).toBeInTheDocument();
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
    // The pill, besides the option in each status dropdown.
    expect(screen.getAllByText("unverified").length).toBeGreaterThanOrEqual(2);
  });

  it("adds an asset by hand", async () => {
    const { refresh } = setup([]);
    vi.mocked(createAsset).mockResolvedValue(fixtureAsset());
    render(<AssetsView mission={mission} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Type"), "subdomain");
    await user.type(screen.getByLabelText("Value"), "dev.example.com");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    expect(createAsset).toHaveBeenCalledWith("mission-1", { type: "subdomain", value: "dev.example.com" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("changes an asset's status, and removes one after a confirm", async () => {
    setup([fixtureAsset()]);
    vi.mocked(setAssetStatus).mockResolvedValue(fixtureAsset({ status: "inactive" }));
    vi.mocked(deleteAsset).mockResolvedValue(fixtureAsset());
    render(<AssetsView mission={mission} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Status of example.com"), "inactive");
    expect(setAssetStatus).toHaveBeenCalledWith("mission-1", "asset-1", "inactive");

    await user.click(screen.getByRole("button", { name: "Remove example.com" }));
    expect(deleteAsset).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(deleteAsset).toHaveBeenCalledWith("mission-1", "asset-1");
  });

  it("rules a host out of scope on the mission and marks it inactive", async () => {
    setup([fixtureAsset()]);
    vi.mocked(updateMission).mockResolvedValue(mission);
    vi.mocked(setAssetStatus).mockResolvedValue(fixtureAsset({ status: "inactive" }));
    render(<AssetsView mission={{ ...mission, outOfScope: ["old.example.com"] }} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Mark example.com out of scope" }));

    await waitFor(() => expect(setAssetStatus).toHaveBeenCalledWith("mission-1", "asset-1", "inactive"));
    expect(updateMission).toHaveBeenCalledWith("mission-1", { outOfScope: ["old.example.com", "example.com"] });
  });

  it("sends a host to the scanner", async () => {
    setup([fixtureAsset()]);
    const scanTarget = vi.fn();
    render(
      <AppNavContext.Provider value={{ scanTarget }}>
        <AssetsView mission={mission} />
      </AppNavContext.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Scan example.com" }));
    expect(scanTarget).toHaveBeenCalledWith("example.com");
  });
});
