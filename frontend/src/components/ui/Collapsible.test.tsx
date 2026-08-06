import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Collapsible } from "./Collapsible";

describe("Collapsible", () => {
  it("is closed by default - children aren't rendered", () => {
    render(<Collapsible trigger="Show details">secret content</Collapsible>);
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("honors defaultOpen", () => {
    render(
      <Collapsible trigger="Show details" defaultOpen>
        secret content
      </Collapsible>,
    );
    expect(screen.getByText("secret content")).toBeInTheDocument();
  });

  it("toggles open and closed when the trigger is clicked", async () => {
    render(<Collapsible trigger="Show details">secret content</Collapsible>);
    const user = userEvent.setup();

    await user.click(screen.getByText("Show details"));
    expect(await screen.findByText("secret content")).toBeInTheDocument();

    await user.click(screen.getByText("Show details"));
    await waitFor(() => expect(screen.queryByText("secret content")).not.toBeInTheDocument());
  });

  it("always renders the trigger content", () => {
    render(<Collapsible trigger={<span>My Trigger</span>}>body</Collapsible>);
    expect(screen.getByText("My Trigger")).toBeInTheDocument();
  });
});
