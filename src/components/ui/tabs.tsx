"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Segmented tabs: a muted track with a white active segment that slides
 * between triggers. Wraps Radix Tabs; the value is tracked here so the
 * sliding indicator knows which trigger is active.
 */
const TabsContext = React.createContext<{ value: string | undefined; group: string }>({ value: undefined, group: "" });

export function Tabs({ value, defaultValue, onValueChange, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  const group = React.useId();
  return (
    <TabsContext.Provider value={{ value: current, group }}>
      <TabsPrimitive.Root
        value={current}
        onValueChange={(v) => {
          setInner(v);
          onValueChange?.(v);
        }}
        {...props}
      >
        {children}
      </TabsPrimitive.Root>
    </TabsContext.Provider>
  );
}

export const TabsContent = TabsPrimitive.Content;

export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List className={cn("seg mb-4 max-w-full overflow-x-auto no-scrollbar", className)}>{children}</TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children, count }: { value: string; children: React.ReactNode; count?: number }) {
  const ctx = React.useContext(TabsContext);
  const reduce = useReducedMotion();
  const active = ctx.value === value;
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn("seg-item relative", active ? "text-slate-900" : "")}
    >
      {active && (
        <motion.span
          layoutId={reduce ? undefined : `tab-${ctx.group}`}
          className="absolute inset-0 rounded-full bg-surface shadow-lift"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
          aria-hidden
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        {children}
        {typeof count === "number" && (
          <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-slate-100 text-slate-700" : "bg-slate-200/60 text-slate-500")}>{count}</span>
        )}
      </span>
    </TabsPrimitive.Trigger>
  );
}
