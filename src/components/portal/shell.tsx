"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LifeBuoy, LogOut, Plus, BookOpen, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalSignOutAction } from "@/actions/portal";
import { PageTransition } from "@/components/page-transition";

/** Minimal customer-facing frame: provider pill, three section pills, sign out. No staff navigation, search or notifications. */
export function PortalShell({ providerName, account, children }: { providerName: string; account: { name: string; companyName: string } | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const items = [
    { href: "/portal", label: "My requests", icon: Ticket, exact: true },
    { href: "/portal/tickets/new", label: "New request", icon: Plus },
    { href: "/portal/kb", label: "Help articles", icon: BookOpen },
  ];
  return (
    <div className="min-h-screen bg-page">
      <header className="sticky top-0 z-20 bg-page/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link href="/portal" className="inline-flex h-11 items-center gap-2.5 rounded-full border border-slate-200 bg-surface pl-1.5 pr-4 text-[13px] font-semibold text-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-500 text-white">
              <LifeBuoy className="h-4 w-4" aria-hidden />
            </span>
            {providerName} support
          </Link>
          {account && (
            <div className="flex items-center gap-2">
              <nav aria-label="Portal" className="pill-group h-11 px-1.5">
                {items.map((it) => {
                  const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
                  return (
                    <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined} className={cn("pill", active && "pill-active")}>
                      <it.icon className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{it.label}</span>
                    </Link>
                  );
                })}
              </nav>
              <form action={portalSignOutAction}>
                <button type="submit" className="pill-icon h-11 w-11 border border-slate-200 bg-surface" title={`${account.name} · ${account.companyName} · Sign out`} aria-label="Sign out">
                  <LogOut className="h-4 w-4" aria-hidden />
                </button>
              </form>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-6 pt-2">
        <PageTransition>{children}</PageTransition>
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-slate-400">{account ? `Signed in as ${account.name}, ${account.companyName}.` : ""}</footer>
    </div>
  );
}
