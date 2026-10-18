import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pill buttons. `primary` is the orange accent and is reserved for the main
 * action on a view; `dark` is the near-black selection colour used for
 * secondary-but-prominent actions (the reference's "Transfer"); `secondary`
 * is the quiet white pill; `ghost` sits on a surface with no outline.
 */
const variants = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 border-transparent",
  dark: "bg-selection text-selection-fg hover:opacity-90 border-transparent",
  secondary: "bg-surface text-slate-800 hover:bg-slate-50 border-slate-200",
  ghost: "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 border-transparent",
  danger: "bg-red-600 text-white hover:bg-red-700 border-transparent",
  "danger-outline": "bg-surface text-red-700 hover:bg-red-50 border-red-200",
} as const;

const sizes = {
  sm: "h-7 px-3 text-xs gap-1.5 [&>svg]:h-3.5 [&>svg]:w-3.5",
  md: "h-8 px-3.5 text-[13px] gap-1.5 [&>svg]:h-4 [&>svg]:w-4",
  lg: "h-9 px-4 text-[13px] gap-2 [&>svg]:h-4 [&>svg]:w-4",
  icon: "h-8 w-8 p-0 [&>svg]:h-4 [&>svg]:w-4",
} as const;

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
};

export function buttonClass(variant: keyof typeof variants = "primary", size: keyof typeof sizes = "md", extra?: string) {
  return cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-full border font-medium transition-[background-color,color,transform,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    extra,
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, children, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: keyof typeof variants; size?: keyof typeof sizes }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}
