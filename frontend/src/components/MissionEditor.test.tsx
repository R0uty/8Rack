import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionEditor } from "./MissionEditor";
import type { Project } from "../types/project";

function project(overrides: Partial<Project> = {}): Project {
  return { id: "p1", name: "Acme", notes: "", createdAt: 0, ...overrides };
}

function setup(overrides: Partial<React.ComponentProps<typeof MissionEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props = { open: true, project: project(), onSave, onClose, ...overrides };
  render(<MissionEditor {...props} />);
  return { onSave, onClose };
}

describe("MissionEditor", () => {
  it("pre-fills the form from the project's existing fields", () => {
    setup({
      project: project({
        description: "External assessment",
        scope: ["example.com", "*.example.com"],
        outOfScope: ["staging.example.com"],
        rules: "No DoS",
        status: "active",
      }),
    });

    expect(screen.getByLabelText("Description")).toHaveValue("External assessment");
    expect(screen.getByLabelText("Scope")).toHaveValue("example.com\n*.example.com");
    expect(screen.getByLabelText("Out of scope")).toHaveValue("staging.example.com");
    expect(screen.getByLabelText("Rules of engagement")).toHaveValue("No DoS");
    expect(screen.getByLabelText("Status")).toHaveValue("active");
  });

  it("splits scope/outOfScope textareas into arrays, one entry per non-empty line", async () => {
    const { onSave } = setup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Scope"), "example.com\n\n *.example.com \n");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ scope: ["example.com", "*.example.com"] }),
    );
  });

  it("omits scope/outOfScope/rules/description/status entirely when left blank", async () => {
    const { onSave } = setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ scope: [], outOfScope: [], rules: "", description: "", status: undefined }),
    );
  });

  it("converts the date input to an epoch-ms startDate", async () => {
    const { onSave } = setup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Start date"), "2026-01-15");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const [, patch] = onSave.mock.calls[0] as [string, { startDate?: number }];
    expect(new Date(patch.startDate!).toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("closes without saving when there is nothing to edit yet (project is null)", () => {
    setup({ project: null });
    expect(screen.getByText("Edit Mission")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("Save changes is disabled once the name is cleared", async () => {
    setup();
    const user = userEvent.setup();
    const nameInput = screen.getByDisplayValue("Acme");
    await user.clear(nameInput);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("closes the sheet after a successful save", async () => {
    const { onClose } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error and stays open when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network error"));
    const { onClose } = setup({ onSave });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
