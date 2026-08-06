import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptInput } from "./PromptInput";

function setup(overrides: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const props = {
    value: "",
    onChange,
    onSubmit,
    onCancel,
    sending: false,
    disabled: false,
    ...overrides,
  };
  render(<PromptInput {...props} />);
  return { onChange, onSubmit, onCancel };
}

describe("PromptInput", () => {
  it("calls onChange as the user types", async () => {
    const { onChange } = setup();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Send a message…"), "hi");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, "h");
    expect(onChange).toHaveBeenNthCalledWith(2, "i");
  });

  it("submits on Enter and prevents the default newline", async () => {
    const { onSubmit } = setup({ value: "hello" });
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Send a message…"));
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter", async () => {
    const { onSubmit } = setup({ value: "hello" });
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Send a message…"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits via the send button, and prevents the form's default submit", async () => {
    const { onSubmit } = setup({ value: "hello" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the send button when the value is blank", () => {
    setup({ value: "   " });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("disables the send button when disabled is set, even with content", () => {
    setup({ value: "hello", disabled: true });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows a Stop button instead of Send while sending, and Enter doesn't resubmit", async () => {
    const { onSubmit, onCancel } = setup({ value: "hello", sending: true });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "Stop generating" });

    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Send a message…"));
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(stopButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the textarea when disabled is set", () => {
    setup({ disabled: true });
    expect(screen.getByPlaceholderText("Send a message…")).toBeDisabled();
  });
});
