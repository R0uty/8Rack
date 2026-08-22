import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sheet } from "./Sheet";

function Harness({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <>
      <button onClick={() => onOpenChange(true)}>Open sheet</button>
      <Sheet open={open} onClose={() => onOpenChange(false)} title="Test Sheet">
        <button>First field</button>
        <button>Second field</button>
      </Sheet>
    </>
  );
}

function renderSheet() {
  let open = false;
  const onOpenChange = vi.fn((next: boolean) => {
    open = next;
    rerender(<Harness open={open} onOpenChange={onOpenChange} />);
  });
  const { rerender } = render(<Harness open={open} onOpenChange={onOpenChange} />);
  return { rerender, onOpenChange };
}

describe("Sheet", () => {
  it("exposes dialog semantics", async () => {
    renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));

    const dialog = await screen.findByRole("dialog", { name: "Test Sheet" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the panel on open", async () => {
    renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
  });

  it("restores focus to the opener on close", async () => {
    renderSheet();
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("closes on Escape", async () => {
    const { onOpenChange } = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    // Escape is handled by a keydown listener on the panel itself, so it only bubbles there once
    // focus has actually landed inside the dialog (the async requestAnimationFrame focus-move) -
    // not merely once the dialog element exists in the DOM.
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("traps Tab within the panel instead of letting it reach background content", async () => {
    renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());

    const close = screen.getByRole("button", { name: "Close" });
    const secondField = screen.getByRole("button", { name: "Second field" });
    secondField.focus();
    expect(secondField).toHaveFocus();

    // Tabbing forward from the last focusable element wraps back to the first, never reaching the
    // "Open sheet" button that sits outside the panel in the background.
    await userEvent.tab();
    expect(close).toHaveFocus();
  });
});
