import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionEditor } from "./MissionEditor";
import type { Mission } from "../types/mission";

function mission(overrides: Partial<Mission> = {}): Mission {
  return { id: "p1", name: "Acme", notes: "", createdAt: 0, ...overrides };
}

function setup(overrides: Partial<React.ComponentProps<typeof MissionEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props = { open: true, mission: mission(), onSave, onDelete, onClose, ...overrides };
  render(<MissionEditor {...props} />);
  return { onSave, onDelete, onClose };
}

describe("MissionEditor", () => {
  it("pre-fills the form from the mission's existing fields", () => {
    setup({
      mission: mission({
        description: "External assessment",
        scope: ["example.com", "*.example.com"],
        outOfScope: ["staging.example.com"],
        rules: "No DoS",
        status: "recon",
      }),
    });

    expect(screen.getByLabelText("Description")).toHaveValue("External assessment");
    expect(screen.getByLabelText("Scope")).toHaveValue("example.com\n*.example.com");
    expect(screen.getByLabelText("Out of scope")).toHaveValue("staging.example.com");
    expect(screen.getByLabelText("Rules of engagement")).toHaveValue("No DoS");
    expect(screen.getByLabelText("Status")).toHaveValue("recon");
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

  it("creates a mission with its scope in one go when mission is null", async () => {
    const { onSave } = setup({ mission: null });
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Create mission" })).toBeDisabled();
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "New one");
    await user.type(screen.getByLabelText("Scope"), "example.com");
    await user.click(screen.getByRole("button", { name: "Create mission" }));

    expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({ name: "New one", scope: ["example.com"] }));
  });

  it("only deletes after a second, explicit confirmation", async () => {
    const { onDelete, onClose } = setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Delete mission" }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onDelete).toHaveBeenCalledWith("p1");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no delete while creating", () => {
    setup({ mission: null });
    expect(screen.queryByRole("button", { name: "Delete mission" })).not.toBeInTheDocument();
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
