import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  /** Applied to just the icon, e.g. "animate-spin" while a refresh/reindex action is in flight —
   * matches the spin treatment every IconButton refresh control already uses. */
  iconClassName?: string;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-primary text-black font-medium hover:brightness-110 shadow-[0_0_0_1px_rgba(0,230,118,0.4)]",
  secondary: "bg-card border border-border text-text hover:border-border-strong hover:bg-card-hover",
  ghost: "bg-transparent text-muted hover:text-text hover:bg-card",
  danger: "bg-transparent border border-critical/40 text-critical hover:bg-critical-dim",
};

const SIZE: Record<Size, string> = {
  sm: "text-xs px-2.5 py-1.5 gap-1.5",
  md: "text-sm px-3.5 py-2 gap-2",
};

/** Shared keyboard-focus ring - browsers only apply `:focus-visible` for keyboard/programmatic
 * focus, not mouse clicks, so this doesn't add a ring around every click. */
export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconClassName,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed",
        FOCUS_RING,
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} strokeWidth={2} className={iconClassName} />}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
}

const ICON_BOX: Record<Size, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
};

export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  active = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed",
        FOCUS_RING,
        ICON_BOX[size],
        active ? "bg-primary-dim text-primary" : VARIANT[variant],
        className,
      )}
      {...rest}
    >
      <Icon size={size === "sm" ? 14 : 16} strokeWidth={2} />
    </button>
  );
}
