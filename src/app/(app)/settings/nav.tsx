"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function SettingsNav({ items }: { items: { href: string; label: string; /** Extra path prefixes this item is highlighted for (e.g. draft pages under the run). */ also?: string[] }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
      {items.map((it, i) => {
        // The first item is the section root and matches exactly; the others match their own path and anything beneath it.
        const path = it.href.split("?")[0];
        const under = (base: string) => pathname === base || pathname.startsWith(base + "/");
        const active = i === 0 ? pathname === path : under(path) || (it.also ?? []).some(under);
        return (
          <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-sm whitespace-nowrap", active ? "bg-surface font-medium text-brand-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-slate-100")}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
