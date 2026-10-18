"use client";

import { PillNav } from "@/components/ui/pill-nav";

/** Second-level navigation inside a page (the first-level section pills live in the top bar). */
export function HelpdeskNav({ items }: { items: { href: string; label: string; count?: number | null; exact?: boolean }[] }) {
  return <PillNav items={items.map((it) => ({ ...it, count: it.count ?? undefined }))} ariaLabel="Sections" variant="group" className="mb-5 !justify-start" />;
}
