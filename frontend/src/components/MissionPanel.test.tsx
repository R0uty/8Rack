import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionPanel } from "./MissionPanel";
import type { Mission } from "../types/mission";

function mission(overrides: Partial<Mission> = {}): Mission {
  return { id: "p1", name: "Acme", notes: "scope notes", createdAt: 0, ...overrides };
}

function setup(overrides: Partial<React.ComponentProps<typeof MissionPanel>> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onRefresh = vi.fn();
  const props = {
    missions: [],
    loading: false,
    error: null,
    selectedMissionId: null,
    onSelect,
    onCreate,
    onUpdate,
    onDelete,
    onRefresh,
    ...overrides,
  };
  render(<MissionPanel {...props} />);
  return { onSelect, onCreate, onUpdate, onDelete, onRefresh };
}

describe("MissionPanel", () => {
  it("shows an empty state with no missions", () => {
    setup();
    expect(screen.getByText(/No missions yet/)).toBeInTheDocument();
  });

  it("renders each mission's name and notes, and selecting one calls onSelect", async () => {
    const p = mission();
    const { onSelect } = setup({ missions: [p] });
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("scope notes")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Acme"));
    expect(onSelect).toHaveBeenCalledWith(p);
  });

  it("opens the create form, and Create is disabled until a name is entered", async () => {
    const { onCreate } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));

    const createButton = screen.getByRole("button", { name: "Create" });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Mission name"), "New Mission");
    expect(createButton).toBeEnabled();

    await user.click(createButton);
    expect(onCreate).toHaveBeenCalledWith("New Mission", "");
  });

  it("trims name/notes before calling onCreate, and closes the form on success", async () => {
    const { onCreate } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(screen.getByPlaceholderText("Mission name"), "  Spaced  ");
    await user.type(
      screen.getByPlaceholderText("Notes (target scope, program, anything worth remembering)"),
      "  notes  ",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith("Spaced", "notes");
    expect(screen.queryByPlaceholderText("Mission name")).not.toBeInTheDocument();
  });

  it("shows a create error and keeps the form open on failure", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("name already taken"));
    setup({ onCreate });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(screen.getByPlaceholderText("Mission name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("name already taken")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Mission name")).toBeInTheDocument();
  });

  it("Cancel closes the create form without calling onCreate", async () => {
    const { onCreate } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByPlaceholderText("Mission name")).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("delete requires a two-step confirm - first click arms it, second click deletes", async () => {
    const { onDelete } = setup({ missions: [mission()] });
    const user = userEvent.setup();

    await user.click(screen.getByTitle("Delete mission"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Acme"?')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("p1");
  });

  it("delete confirmation Cancel backs out without deleting", async () => {
    const { onDelete } = setup({ missions: [mission()] });
    const user = userEvent.setup();

    await user.click(screen.getByTitle("Delete mission"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete "Acme"?')).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("calls onRefresh from the refresh button", async () => {
    const { onRefresh } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh missions" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables New and per-mission delete while disabled is set", () => {
    setup({ missions: [mission()], disabled: true });
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
    expect(screen.getByTitle("Delete mission")).toBeDisabled();
  });

  it("shows a status pill when the mission has a mission status set", () => {
    setup({ missions: [mission({ status: "recon" })] });
    expect(screen.getByText("recon")).toBeInTheDocument();
  });

  it("opens the mission editor from the per-mission Edit affordance and saves a patch", async () => {
    const { onUpdate } = setup({ missions: [mission()] });
    const user = userEvent.setup();

    await user.click(screen.getByTitle("Edit mission details"));
    expect(screen.getByText("Edit Acme")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("What is this engagement, at a glance?"), "Authorized pentest");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onUpdate).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ name: "Acme", description: "Authorized pentest" }),
    );
  });
});
