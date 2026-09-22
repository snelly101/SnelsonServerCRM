import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  orange: "bg-orange-50 text-orange-700 ring-orange-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  green: "bg-green-50 text-green-700 ring-green-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  purple: "bg-purple-50 text-purple-700 ring-purple-200",
  pink: "bg-pink-50 text-pink-700 ring-pink-200",
};

export function Badge({ tone = "slate", className, children }: { tone?: string; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap", tones[tone] ?? tones.slate, className)}>
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
