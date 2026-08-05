import { useEffect, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { GlassPanel, IconButton } from "./ui";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  sending: boolean;
  disabled: boolean;
}

const MAX_HEIGHT = 200;

export function PromptInput({ value, onChange, onSubmit, onCancel, sending, disabled }: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

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
    <form onSubmit={handleSubmit}>
      <GlassPanel padding="none" className="flex items-end gap-2 p-2.5" raised>
        <textarea
          ref={textareaRef}
          className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text placeholder:text-muted focus:outline-none disabled:opacity-50"
          placeholder="Send a message…"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        {sending ? (
          <IconButton icon={Square} label="Stop generating" variant="danger" onClick={onCancel} />
        ) : (
          <IconButton
            icon={ArrowUp}
            label="Send message"
            variant="primary"
            type="submit"
            disabled={disabled || !value.trim()}
          />
        )}
      </GlassPanel>
    </form>
  );
}
