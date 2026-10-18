"use client";

import { PillNav, type PillItem } from "@/components/ui/pill-nav";

/** Second-level navigation inside a page (the first-level section pills live in the top bar). */
export function SettingsNav({ items, ariaLabel = "Sections" }: { items: PillItem[]; ariaLabel?: string }) {
  return <PillNav items={items.map((it, i) => ({ ...it, exact: it.exact ?? i === 0 }))} ariaLabel={ariaLabel} variant="group" className="mb-5 !justify-start" />;
}
