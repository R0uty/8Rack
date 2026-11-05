import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { IconButton } from "./Button";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-docked glass panel over a backdrop. Backs 4 surfaces (AgentEditor/MissionEditor/
 * FindingDetails/ReportsPanel), so the focus management here (previously: none at all - a real
 * accessibility gap flagged in an audit)
 * fixes all of them at once: focus moves into the panel on open and back to whatever opened it on
 * close, Tab is trapped inside the panel instead of reaching background content, and Escape closes
 * it like every other modal convention. */
export function Sheet({ open, onClose, title, children, width = "max-w-sm" }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    // Deferred a tick so framer-motion has mounted the panel's children before the focusable-query
    // below runs against them.
    const id = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      // Restore focus to whatever opened the sheet - without this, focus silently lands on
      // <body> on close, and a keyboard user loses their place in the page entirely.
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [open]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    // Wrap Tab at the panel's own edges instead of letting it escape into the dimmed background
    // content, which is the whole point of a focus trap - a screen-reader or keyboard-only user
    // would otherwise Tab straight past an open modal into a page they can't currently see.
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            initial={{ x: 32, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 32, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={`flex h-full w-full ${width} flex-col border-l border-border bg-surface/95 backdrop-blur-xl outline-none`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold tracking-wide text-text">{title}</h2>
              <IconButton icon={X} label="Close" onClick={onClose} />
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
