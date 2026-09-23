"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SectionItem = { key: string; label: string; href: string; count?: number };

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Horizontal section navigation for a record page. Sections are real links
 * (deep-linkable, back button works). When the row is too narrow the
 * trailing sections move into a "More" menu instead of wrapping; the active
 * section is always identifiable, including when it sits inside the menu.
 */
export function SectionNav({ items, active, ariaLabel = "Sections" }: { items: SectionItem[]; active: string; ariaLabel?: string }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(items.length);

  useIsoLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const MORE_WIDTH = 84;
    const compute = () => {
      const available = row.clientWidth;
      const widths = Array.from(measure.children).map((c) => (c as HTMLElement).offsetWidth);
      let used = 0;
      let fit = 0;
      for (let i = 0; i < widths.length; i++) {
        const needsMore = i < widths.length - 1;
        if (used + widths[i] + (needsMore ? MORE_WIDTH : 0) <= available) {
          used += widths[i];
          fit = i + 1;
        } else break;
      }
      // If everything but the last fits without a More button, keep it all.
      const total = widths.reduce((a, b) => a + b, 0);
      setVisible(total <= available ? widths.length : Math.max(1, fit));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(row);
    return () => ro.disconnect();
  }, [items]);

  const shown = items.slice(0, visible);
  const overflow = items.slice(visible);
  const activeInOverflow = overflow.find((i) => i.key === active);

  const link = (item: SectionItem, inMenu = false) => {
    const isActive = item.key === active;
    return (
      <Link
        key={item.key}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          inMenu
            ? "flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100"
            : "-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:rounded-t focus-visible:ring-2 focus-visible:ring-brand-500",
          isActive ? (inMenu ? "text-brand-700" : "border-brand-600 text-brand-700") : inMenu ? "text-slate-700" : "border-transparent text-slate-500 hover:text-slate-800",
        )}
      >
        {item.label}
        {typeof item.count === "number" && item.count > 0 && <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", isActive ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600")}>{item.count}</span>}
      </Link>
    );
  };

  return (
    <nav aria-label={ariaLabel} className="relative border-b border-slate-200">
      {/* Off-screen copy used only to measure natural widths. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap">
        {items.map((i) => link(i))}
      </div>
      <div ref={rowRef} className="flex flex-nowrap items-stretch overflow-hidden">
        {shown.map((i) => link(i))}
        {overflow.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:rounded-t focus-visible:ring-2 focus-visible:ring-brand-500",
                activeInOverflow ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
              )}
              aria-label={activeInOverflow ? `More sections (current: ${activeInOverflow.label})` : "More sections"}
            >
              {activeInOverflow ? activeInOverflow.label : "More"} <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="z-40 min-w-[180px] rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                {overflow.map((i) => (
                  <DropdownMenu.Item key={i.key} asChild>
                    {link(i, true)}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </nav>
  );
}
