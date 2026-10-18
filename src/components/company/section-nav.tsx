"use client";

import { PillNav } from "@/components/ui/pill-nav";

export type SectionItem = { key: string; label: string; href: string; count?: number };

/**
 * Horizontal section navigation for a record page. Sections are real links
 * (deep-linkable, back button works); sections that do not fit move into a
 * "More" menu and the active one is always identifiable.
 */
export function SectionNav({ items, active, ariaLabel = "Sections" }: { items: SectionItem[]; active: string; ariaLabel?: string }) {
  return <PillNav items={items} activeKey={active} ariaLabel={ariaLabel} variant="group" className="!justify-start" />;
}
