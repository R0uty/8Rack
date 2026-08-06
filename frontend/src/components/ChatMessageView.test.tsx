import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessageView } from "./ChatMessageView";
import type { ChatMessage } from "../types/chat";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "assistant", content: "Hello there", createdAt: 0, ...overrides };
}

describe("ChatMessageView", () => {
  it("renders a tool-result message distinctly, in a <pre> block", () => {
    render(<ChatMessageView message={message({ role: "tool", content: "2" })} />);
    expect(screen.getByText("tool result")).toBeInTheDocument();
    expect(screen.getByText("2").tagName).toBe("PRE");
  });

  it("renders assistant markdown content", () => {
    render(<ChatMessageView message={message({ content: "**bold** text" })} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("labels the role and right-aligns a user message", () => {
    const { container } = render(<ChatMessageView message={message({ role: "user", content: "hi" })} />);
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("self-end");
  });

  it("renders tool calls instead of markdown content when present", () => {
    render(
      <ChatMessageView
        message={message({ content: "", toolCalls: [{ name: "calc", arguments: { expr: "1+1" } }] })}
      />,
    );
    expect(screen.getByText(/calc\(/)).toBeInTheDocument();
  });

  it("shows an error message", () => {
    render(<ChatMessageView message={message({ error: "Request failed" })} />);
    expect(screen.getByText("Request failed")).toBeInTheDocument();
  });

  it("shows 'Cancelled' only when cancelled and there is no error", () => {
    const { rerender } = render(<ChatMessageView message={message({ cancelled: true })} />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();

    rerender(<ChatMessageView message={message({ cancelled: true, error: "Request failed" })} />);
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
  });

  it("hides the Copy button while streaming or with no content", () => {
    const { rerender } = render(<ChatMessageView message={message({ streaming: true })} />);
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();

    rerender(<ChatMessageView message={message({ content: "", streaming: false })} />);
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });

  it("hides the Copy button for a tool-calls message", () => {
    render(
      <ChatMessageView
        message={message({ content: "", toolCalls: [{ name: "calc", arguments: {} }], streaming: false })}
      />,
    );
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });

  describe("copy button", () => {
    afterEach(() => vi.useRealTimers());

    it("copies the message content and shows 'Copied' briefly", async () => {
      // userEvent.setup() installs its own navigator.clipboard implementation (to support
      // user.copy()/paste()) - it must run before we spy on writeText, or setup() clobbers our spy.
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<ChatMessageView message={message({ content: "Hello there" })} />);

      await user.click(screen.getByText("Copy"));

      expect(writeText).toHaveBeenCalledWith("Hello there");
      expect(await screen.findByText("Copied")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByText("Copy")).toBeInTheDocument();
    });
  });
});
