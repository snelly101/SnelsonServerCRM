"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LifeBuoy, LogOut, Plus, BookOpen, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalSignOutAction } from "@/actions/portal";

/** Minimal customer-facing frame: provider name, three links, who is signed in. No staff navigation, search or notifications. */
export function PortalShell({ providerName, account, children }: { providerName: string; account: { name: string; companyName: string } | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const items = [
    { href: "/portal", label: "My requests", icon: Ticket, exact: true },
    { href: "/portal/tickets/new", label: "New request", icon: Plus },
    { href: "/portal/kb", label: "Help articles", icon: BookOpen },
  ];
  return (
    <div className="min-h-screen bg-page">
      <header className="border-b border-slate-200 bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/portal" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <LifeBuoy className="h-5 w-5 text-brand-600" aria-hidden /> {providerName} support
          </Link>
          {account && (
            <nav aria-label="Portal" className="flex flex-wrap items-center gap-1 text-sm">
              {items.map((it) => {
                const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
                return (
                  <Link key={it.href} href={it.href} className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5", active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100")}>
                    <it.icon className="h-4 w-4" aria-hidden /> {it.label}
                  </Link>
                );
              })}
              <form action={portalSignOutAction}>
                <button type="submit" className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-slate-600 hover:bg-slate-100" title={`${account.name} · ${account.companyName}`}>
                  <LogOut className="h-4 w-4" aria-hidden /> Sign out
                </button>
              </form>
            </nav>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-slate-400">{account ? `Signed in as ${account.name}, ${account.companyName}.` : ""}</footer>
    </div>
  );
}
