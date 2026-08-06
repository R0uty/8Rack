import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectPanel } from "./ProjectPanel";
import type { Project } from "../types/project";

function project(overrides: Partial<Project> = {}): Project {
  return { id: "p1", name: "Acme", notes: "scope notes", createdAt: 0, ...overrides };
}

function setup(overrides: Partial<React.ComponentProps<typeof ProjectPanel>> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onRefresh = vi.fn();
  const props = {
    projects: [],
    loading: false,
    error: null,
    selectedProjectId: null,
    onSelect,
    onCreate,
    onDelete,
    onRefresh,
    ...overrides,
  };
  render(<ProjectPanel {...props} />);
  return { onSelect, onCreate, onDelete, onRefresh };
}

describe("ProjectPanel", () => {
  it("shows an empty state with no projects", () => {
    setup();
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
  });

  it("renders each project's name and notes, and selecting one calls onSelect", async () => {
    const p = project();
    const { onSelect } = setup({ projects: [p] });
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

    await user.type(screen.getByPlaceholderText("Project name"), "New Project");
    expect(createButton).toBeEnabled();

    await user.click(createButton);
    expect(onCreate).toHaveBeenCalledWith("New Project", "");
  });

  it("trims name/notes before calling onCreate, and closes the form on success", async () => {
    const { onCreate } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(screen.getByPlaceholderText("Project name"), "  Spaced  ");
    await user.type(
      screen.getByPlaceholderText("Notes (target scope, program, anything worth remembering)"),
      "  notes  ",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith("Spaced", "notes");
    expect(screen.queryByPlaceholderText("Project name")).not.toBeInTheDocument();
  });

  it("shows a create error and keeps the form open on failure", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("name already taken"));
    setup({ onCreate });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(screen.getByPlaceholderText("Project name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("name already taken")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Project name")).toBeInTheDocument();
  });

  it("Cancel closes the create form without calling onCreate", async () => {
    const { onCreate } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByPlaceholderText("Project name")).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("delete requires a two-step confirm - first click arms it, second click deletes", async () => {
    const { onDelete } = setup({ projects: [project()] });
    const user = userEvent.setup();

    await user.click(screen.getByTitle("Delete project"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Acme"?')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("p1");
  });

  it("delete confirmation Cancel backs out without deleting", async () => {
    const { onDelete } = setup({ projects: [project()] });
    const user = userEvent.setup();

    await user.click(screen.getByTitle("Delete project"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete "Acme"?')).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("calls onRefresh from the refresh button", async () => {
    const { onRefresh } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh projects" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables New and per-project delete while disabled is set", () => {
    setup({ projects: [project()], disabled: true });
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
    expect(screen.getByTitle("Delete project")).toBeDisabled();
  });
});
