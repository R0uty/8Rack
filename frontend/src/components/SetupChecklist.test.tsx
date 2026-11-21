import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupChecklist } from "./SetupChecklist";
import { fetchSetupStatus } from "../services/setupApi";
import type { SetupStatus } from "../types/setup";

vi.mock("../services/setupApi", () => ({ fetchSetupStatus: vi.fn() }));
const mockFetch = vi.mocked(fetchSetupStatus);

const notReady: SetupStatus = {
  ollama: { id: "ollama", label: "Ollama", state: "ok", detail: "Reachable" },
  models: [{ id: "model:qwen", label: "qwen2.5:14b", state: "missing", detail: "Used by Validator", fix: "ollama pull qwen2.5:14b" }],
  tools: [
    { id: "tool:nmap", label: "nmap", state: "ok" },
    { id: "tool:katana", label: "katana", state: "missing", fix: "go install katana" },
  ],
  ready: false,
};

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
});

describe("SetupChecklist", () => {
  it("renders nothing once everything is ready", async () => {
    mockFetch.mockResolvedValue({ ...notReady, models: [], tools: [], ready: true });
    const { container } = render(<SetupChecklist />);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows what's missing with the command that fixes it", async () => {
    mockFetch.mockResolvedValue(notReady);
    render(<SetupChecklist />);
    expect(await screen.findByRole("region", { name: "Setup checklist" })).toBeInTheDocument();
    expect(screen.getByText("ollama pull qwen2.5:14b")).toBeInTheDocument();
    expect(screen.getByText("go install katana")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 need attention/)).toBeInTheDocument();
  });

  it("stays hidden until a different gap appears", async () => {
    mockFetch.mockResolvedValue(notReady);
    const { unmount } = render(<SetupChecklist />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Setup checklist" })).not.toBeInTheDocument();
    unmount();

    render(<SetupChecklist />);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Setup checklist" })).not.toBeInTheDocument();

    mockFetch.mockResolvedValue({ ...notReady, tools: [...notReady.tools, { id: "tool:amass", label: "amass", state: "missing" }] });
    render(<SetupChecklist />);
    expect(await screen.findByRole("region", { name: "Setup checklist" })).toBeInTheDocument();
  });

  it("checks again on request", async () => {
    mockFetch.mockResolvedValue(notReady);
    render(<SetupChecklist />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Check again" }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
