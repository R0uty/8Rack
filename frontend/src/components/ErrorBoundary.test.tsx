import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "./ErrorBoundary";

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error("boom");
  return <p>recovered</p>;
}

describe("ErrorBoundary", () => {
  it("shows the error instead of a blank page, and can retry", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    shouldThrow = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("clears the error when its reset key changes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    shouldThrow = true;
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="b">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("recovered")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
