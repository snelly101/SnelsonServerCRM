import { cn } from "@/lib/utils";

/* Small, muted status labels: a soft tint and a darker text shade, no outline. */
const tones: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700",
  red: "bg-red-50 text-red-700",
  orange: "bg-brand-50 text-brand-700",
  amber: "bg-amber-50 text-amber-800",
  green: "bg-green-50 text-green-700",
  teal: "bg-teal-50 text-teal-700",
  blue: "bg-blue-50 text-blue-700",
  indigo: "bg-indigo-50 text-indigo-700",
  purple: "bg-purple-50 text-purple-700",
  pink: "bg-pink-50 text-pink-700",
  dark: "bg-selection text-selection-fg",
};

export function Badge({ tone = "slate", className, title, children }: { tone?: string; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4", tones[tone] ?? tones.slate, className)}>
      {children}
    </span>
  );
}

export const STATUS_TONES: Record<string, string> = {
  prospect: "blue",
  customer: "green",
  former: "slate",
  other: "amber",
};

export const ROLE_LABELS_CONTACT: Record<string, string> = {
  decision_maker: "Decision maker",
  technical: "Technical",
  billing: "Billing",
  primary: "Primary",
  other: "Other",
};
