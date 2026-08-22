import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";
import { useAgents } from "./hooks/useAgents";

// App.tsx composes several hooks; only useAgents matters for this regression, so every other hook
// gets a minimal, harmless stub and the heavy per-view components (each pulling in their own
// hooks/network calls, irrelevant here) are stubbed out entirely.
vi.mock("./hooks/useModels", () => ({
  useModels: () => ({ models: [], allModels: [], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("./hooks/useAgents", () => ({ useAgents: vi.fn() }));
vi.mock("./hooks/useTools", () => ({
  useTools: () => ({ tools: [], executions: [], loading: false, error: null, refresh: vi.fn(), toggleTool: vi.fn() }),
}));
vi.mock("./hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { temperature: 0.7, topP: 0.9, maxTokens: 0, contextSize: 0, keepAlive: "5m" },
    update: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("./hooks/useTheme", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn(), toggle: vi.fn() }) }));

vi.mock("./components/FindingsView", () => ({ FindingsView: () => null }));
vi.mock("./components/FactoryDashboard", () => ({ FactoryDashboard: () => null }));
vi.mock("./components/AgentEditor", () => ({ AgentEditor: () => null }));
vi.mock("./components/SettingsPanel", () => ({ SettingsPanel: () => null }));

const mockUseAgents = vi.mocked(useAgents);

describe("App - default landing view", () => {
  it("lands on the Factory Dashboard, not a chat/agent picker", () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      warnings: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });

    render(<App />);

    const factoryButton = screen.getByRole("button", { name: "Factory" });
    expect(factoryButton.className).toContain("bg-primary-dim");
  });
});
