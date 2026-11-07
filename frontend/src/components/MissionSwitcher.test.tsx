import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionSwitcher } from "./MissionSwitcher";
import type { Mission } from "../types/mission";

const a: Mission = { id: "a", name: "Mission A", notes: "", createdAt: 1 };
const b: Mission = { id: "b", name: "Mission B", notes: "", createdAt: 2 };

function setup(overrides: Partial<React.ComponentProps<typeof MissionSwitcher>> = {}) {
  const props = {
    missions: [a, b],
    selected: a,
    loading: false,
    error: null,
    disabled: false,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  };
  render(<MissionSwitcher {...props} />);
  return props;
}

describe("MissionSwitcher", () => {
  it("selects, edits, and starts a new mission", async () => {
    const { onSelect, onEdit, onNew } = setup();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Mission"), "b");
    expect(onSelect).toHaveBeenCalledWith("b");

    await user.click(screen.getByRole("button", { name: "Edit mission" }));
    expect(onEdit).toHaveBeenCalledWith(a);

    await user.click(screen.getByRole("button", { name: "New mission" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("offers only a create button when there are no missions", () => {
    setup({ missions: [], selected: null });
    expect(screen.queryByLabelText("Mission")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New mission" })).toBeInTheDocument();
  });

  it("can't change anything while the factory is advancing the selected mission", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText("Mission")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit mission" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New mission" })).toBeDisabled();
  });
});
