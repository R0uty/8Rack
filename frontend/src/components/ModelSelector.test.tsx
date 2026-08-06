import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "./ModelSelector";
import type { OllamaModel } from "../types/ollama";

function model(name: string): OllamaModel {
  return { name, model: name, modified_at: "", size: 0, digest: "" };
}

describe("ModelSelector", () => {
  it("shows a loading skeleton (no select) when loading with no models yet", () => {
    render(
      <ModelSelector models={[]} loading error={null} selectedModel={null} onSelectModel={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows an empty state when not loading and there are no models", () => {
    render(
      <ModelSelector
        models={[]}
        loading={false}
        error={null}
        selectedModel={null}
        onSelectModel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("No models installed")).toBeInTheDocument();
  });

  it("shows the error message instead of the empty state", () => {
    render(
      <ModelSelector
        models={[]}
        loading={false}
        error="Could not reach the backend server"
        selectedModel={null}
        onSelectModel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("Could not reach the backend server")).toBeInTheDocument();
    expect(screen.queryByText("No models installed")).not.toBeInTheDocument();
  });

  it("lists every model as an option and reflects the selected one", () => {
    render(
      <ModelSelector
        models={[model("a"), model("b")]}
        loading={false}
        error={null}
        selectedModel="b"
        onSelectModel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("b");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("calls onSelectModel when the user picks a different model", async () => {
    const onSelectModel = vi.fn();
    render(
      <ModelSelector
        models={[model("a"), model("b")]}
        loading={false}
        error={null}
        selectedModel="a"
        onSelectModel={onSelectModel}
        onRefresh={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox"), "b");
    expect(onSelectModel).toHaveBeenCalledWith("b");
  });

  it("calls onRefresh when the refresh button is clicked, and disables it while loading", async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ModelSelector
        models={[model("a")]}
        loading={false}
        error={null}
        selectedModel="a"
        onSelectModel={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh model list" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <ModelSelector
        models={[model("a")]}
        loading
        error={null}
        selectedModel="a"
        onSelectModel={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("button", { name: "Refresh model list" })).toBeDisabled();
  });
});
