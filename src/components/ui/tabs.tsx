"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List className={cn("mb-4 flex flex-wrap gap-1 border-b border-slate-200", className)}>{children}</TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children, count }: { value: string; children: React.ReactNode; count?: number }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-700"
    >
      {children}
      {typeof count === "number" && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{count}</span>}
    </TabsPrimitive.Trigger>
  );
}
