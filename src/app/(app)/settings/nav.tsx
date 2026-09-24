"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
      {items.map((it) => {
        const active = it.href === "/settings" ? pathname === "/settings" : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-sm whitespace-nowrap", active ? "bg-surface font-medium text-brand-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-slate-100")}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
