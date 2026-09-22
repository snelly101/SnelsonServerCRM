"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Building2,
  Users,
  KanbanSquare,
  FileText,
  FileSignature,
  ListChecks,
  MonitorSmartphone,
  Landmark,
  BarChart3,
  Plug,
  Settings,
  Menu,
  LogOut,
  X,
} from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { GlobalSearch } from "./global-search";
import { signOut } from "@/lib/auth-client";
import { ROLE_LABELS, type Role } from "@/lib/permissions";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/pipeline", label: "Sales Pipeline", icon: KanbanSquare },
  { href: "/proposals", label: "Proposals", icon: FileText },
  { href: "/contracts", label: "Contracts & Services", icon: FileSignature },
  { href: "/tasks", label: "Tasks & Onboarding", icon: ListChecks },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/finance", label: "Finance", icon: Landmark },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({
  user,
  companyName,
  demoMode,
  children,
}: {
  user: { name: string; email: string; role: Role };
  companyName: string;
  demoMode: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav aria-label="Main" className="flex-1 space-y-0.5 px-2">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              active ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 text-white lg:flex">
        <div className="flex h-14 items-center gap-2 px-4 text-sm font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded bg-brand-500 text-xs">{initials(companyName)}</span>
          <span className="truncate">{companyName}</span>
        </div>
        {nav}
        <div className="border-t border-slate-800 p-3 text-xs text-slate-400">
          <div className="truncate font-medium text-slate-200">{user.name}</div>
          <div className="truncate">{ROLE_LABELS[user.role]}</div>
        </div>
      </aside>

      {/* Sidebar (mobile) */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-slate-900 text-white">
            <div className="flex h-14 items-center justify-between px-4 text-sm font-semibold">
              <span className="truncate">{companyName}</span>
              <button aria-label="Close menu" onClick={() => setOpen(false)} className="rounded p-1 hover:bg-slate-800">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3">
            {demoMode && (
              <span className="hidden rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 sm:inline" title="Integrations without credentials use synthetic demo data">
                DEMO MODE
              </span>
            )}
            <div className="hidden text-right text-xs sm:block">
              <div className="font-medium text-slate-800">{user.name}</div>
              <div className="text-slate-500">{ROLE_LABELS[user.role]}</div>
            </div>
            <button
              className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await signOut();
                router.push("/login");
                router.refresh();
              }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
