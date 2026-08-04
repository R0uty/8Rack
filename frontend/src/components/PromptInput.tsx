import type { KeyboardEvent } from "react";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  sending: boolean;
  disabled: boolean;
}

export function PromptInput({ value, onChange, onSubmit, onCancel, sending, disabled }: PromptInputProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sending) onSubmit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending) onSubmit();
    }
  };

  return (
    <form className="prompt-input" onSubmit={handleSubmit}>
      <textarea
        className="prompt-input__textarea"
        placeholder="Send a message..."
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <div className="prompt-input__actions">
        {sending ? (
          <button type="button" className="prompt-input__send prompt-input__send--stop" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="prompt-input__send" disabled={disabled || !value.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
