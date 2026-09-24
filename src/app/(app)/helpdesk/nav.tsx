"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function HelpdeskNav({
  items,
}: {
  items: {
    href: string;
    label: string;
    count?: number | null;
    exact?: boolean;
  }[];
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Helpdesk sections"
      className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      {items.map((it) => {
        const active = it.exact
          ? pathname === it.href
          : pathname === it.href || pathname.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              active
                ? "border-brand-600 font-medium text-brand-700"
                : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-800",
            )}
          >
            {it.label}
            {typeof it.count === "number" && it.count > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600">
                {it.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
