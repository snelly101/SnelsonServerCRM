"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { sectionItemActive } from "@/components/nav-config";

export type PillItem = {
  key?: string;
  href: string;
  label: string;
  count?: number;
  exact?: boolean;
  also?: string[];
};

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A row of pill links with a sliding active pill. Items that do not fit the
 * available width move into a "More" menu; the active item is always
 * identifiable, including when it sits inside the menu.
 *
 * - `group`: a white rounded cluster (the top bar), `bare`: pills directly on the page.
 * - Active state is derived from the pathname, or from `activeKey` when given.
 */
export function PillNav({
  items,
  activeKey,
  ariaLabel,
  variant = "bare",
  className,
  overflow = true,
}: {
  items: PillItem[];
  activeKey?: string;
  ariaLabel: string;
  variant?: "group" | "bare";
  className?: string;
  overflow?: boolean;
}) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const group = useId();
  const outerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(items.length);

  const isActive = (it: PillItem) =>
    activeKey !== undefined
      ? it.key === activeKey
      : sectionItemActive(pathname, it);

  useIsoLayoutEffect(() => {
    if (!overflow) {
      setVisible(items.length);
      return;
    }
    // Measure the wrapper (which takes the full width on offer), never the row
    // itself: the row shrinks to its content, so a transient narrow layout
    // would otherwise lock the overflow in.
    const outer = outerRef.current;
    const measure = measureRef.current;
    if (!outer || !measure) return;
    const MORE_WIDTH = 88;
    const PADDING = variant === "group" ? 12 : 0;
    const compute = () => {
      const available = outer.clientWidth - PADDING;
      const widths = Array.from(measure.children).map(
        (c) => (c as HTMLElement).offsetWidth + 2,
      );
      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= available) {
        setVisible(widths.length);
        return;
      }
      let used = 0;
      let fit = 0;
      for (let i = 0; i < widths.length; i++) {
        if (used + widths[i] + MORE_WIDTH <= available) {
          used += widths[i];
          fit = i + 1;
        } else break;
      }
      setVisible(Math.max(1, fit));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [items, overflow, variant]);

  const shown = items.slice(0, visible);
  const rest = items.slice(visible);
  const activeInRest = rest.find(isActive);

  const pill = (it: PillItem, inMenu = false) => {
    const active = isActive(it);
    if (inMenu) {
      return (
        <Link
          key={it.key ?? it.href}
          href={it.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "menu-item justify-between",
            active && "font-medium text-slate-900",
          )}
        >
          {it.label}
          {typeof it.count === "number" && it.count > 0 && (
            <span className="rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums text-slate-600">
              {it.count}
            </span>
          )}
        </Link>
      );
    }
    return (
      <Link
        key={it.key ?? it.href}
        href={it.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "pill relative",
          active && "text-selection-fg hover:text-selection-fg",
        )}
      >
        {active && (
          <motion.span
            layoutId={reduce ? undefined : `pill-${group}`}
            className="absolute inset-0 rounded-full bg-selection"
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            aria-hidden
          />
        )}
        <span className="relative z-10 inline-flex items-center gap-1.5">
          {it.label}
          {typeof it.count === "number" && it.count > 0 && (
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] tabular-nums",
                active
                  ? "bg-white/20 text-selection-fg"
                  : "bg-slate-100 text-slate-600",
              )}
            >
              {it.count}
            </span>
          )}
        </span>
      </Link>
    );
  };

  return (
    <div
      ref={outerRef}
      className={cn(
        "flex w-full min-w-0",
        variant === "group" && "justify-center",
        className,
      )}
    >
      <nav
        aria-label={ariaLabel}
        className={cn(
          "relative min-w-0 max-w-full",
          variant === "group" ? "pill-group" : "",
        )}
      >
        {overflow && (
          <div
            ref={measureRef}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap gap-0.5"
          >
            {items.map((it) => (
              <span key={it.key ?? it.href} className="pill">
                {it.label}
                {typeof it.count === "number" && it.count > 0 && (
                  <span className="px-1.5 text-[11px]">{it.count}</span>
                )}
              </span>
            ))}
          </div>
        )}
        <div
          ref={rowRef}
          className={cn(
            "flex min-w-0 flex-nowrap items-center gap-0.5",
            overflow ? "overflow-hidden" : "overflow-x-auto no-scrollbar",
          )}
        >
          {shown.map((it) => pill(it))}
          {rest.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                className={cn("pill relative", activeInRest && "pill-active")}
                aria-label={
                  activeInRest
                    ? `More sections (current: ${activeInRest.label})`
                    : "More sections"
                }
              >
                {activeInRest ? activeInRest.label : "More"}{" "}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="menu"
                >
                  {rest.map((it) => (
                    <DropdownMenu.Item key={it.key ?? it.href} asChild>
                      {pill(it, true)}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </nav>
    </div>
  );
}
