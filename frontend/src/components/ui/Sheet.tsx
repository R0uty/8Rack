import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { IconButton } from "./Button";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Tailwind max-width class for the panel - defaults to the original SettingsPanel width. */
  width?: string;
}

/** Right-docked glass panel over a backdrop - replaces SettingsPanel's bespoke modal markup. */
export function Sheet({ open, onClose, title, children, width = "max-w-sm" }: SheetProps) {
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
            initial={{ x: 32, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 32, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={`flex h-full w-full ${width} flex-col border-l border-border bg-surface/95 backdrop-blur-xl`}
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
