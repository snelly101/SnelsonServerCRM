"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu, LogOut, ShieldCheck, Bell, X, ChevronDown, LifeBuoy } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { SearchCommand } from "./global-search";
import { signOut } from "@/lib/auth-client";
import { ROLE_LABELS, type Role } from "@/lib/permissions";
import { ThemeRail, ThemeSync } from "./theme-toggle";
import { ToastProvider } from "./ui/toast";
import { PillNav } from "./ui/pill-nav";
import { PageTransition } from "./page-transition";
import { PRIMARY_NAV, sectionItems, type SectionCounts } from "./nav-config";
import type { ThemePref } from "@/lib/theme";

/**
 * The application frame: a narrow icon rail on the left made of white pill
 * clusters, a floating top bar (brand pill, the current module's section
 * pills, utilities and the account pill) and the page below. Everything sits
 * directly on the page background; only the pills and cards are white.
 */
export function AppShell({
  user,
  companyName,
  demoMode,
  twoFactorDueBy = null,
  unreadNotifications = 0,
  counts = {},
  children,
}: {
  user: { name: string; email: string; role: Role; theme: ThemePref };
  companyName: string;
  demoMode: boolean;
  /** Set when the security policy requires 2FA the user has not enrolled in yet and the grace period is still running. */
  twoFactorDueBy?: string | null;
  /** Unread helpdesk notifications for the bell in the header. */
  unreadNotifications?: number;
  /** Live counts shown on section pills. */
  counts?: SectionCounts;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));
  const sections = sectionItems(pathname, user.role, { ...counts, unread: unreadNotifications });

  const doSignOut = async () => {
    await signOut();
    router.push("/login");
    router.refresh();
  };

  const rail = (
    <nav aria-label="Main" className="flex flex-col items-center gap-0.5 rounded-full border border-slate-200 bg-surface p-1">
      {PRIMARY_NAV.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            className={cn("group relative pill-icon h-9 w-9", active && "pill-active")}
          >
            <item.icon className="h-4 w-4" aria-hidden />
            <span className="pointer-events-none absolute left-full top-1/2 z-30 ml-2.5 -translate-y-1/2 whitespace-nowrap rounded-lg bg-selection px-2 py-1 text-xs font-medium text-selection-fg opacity-0 shadow-pop transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      {/* Icon rail (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-[68px] shrink-0 flex-col items-center gap-3 self-start overflow-y-auto px-3 pb-4 pt-4 no-scrollbar lg:flex">
        <ThemeRail initial={user.theme} />
        <div className="my-auto">{rail}</div>
        <div className="flex flex-col items-center gap-0.5 rounded-full border border-slate-200 bg-surface p-1">
          <Link href="/helpdesk/notifications" aria-label="Notifications" className="group relative pill-icon h-8 w-8">
            <Bell className="h-4 w-4" aria-hidden />
            {unreadNotifications > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand-500 ring-2 ring-surface" />}
          </Link>
          <button type="button" aria-label="Sign out" title="Sign out" className="pill-icon h-8 w-8" onClick={doSignOut}>
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </aside>

      {/* Drawer (mobile) */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade bg-slate-950/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-surface p-3 shadow-pop">
            <div className="flex h-12 items-center justify-between px-2">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-500 text-[11px] font-bold text-white">{initials(companyName)}</span>
                {companyName}
              </span>
              <button aria-label="Close menu" onClick={() => setOpen(false)} className="pill-icon h-8 w-8">
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label="Main" className="mt-2 flex-1 space-y-0.5 overflow-y-auto">
              {PRIMARY_NAV.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link key={item.href} href={item.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined} className={cn("pill h-9 w-full justify-start px-3", active && "pill-active")}>
                    <item.icon className="h-4 w-4" aria-hidden />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-2 flex items-center justify-between px-2">
              <ThemeRailInline initial={user.theme} />
              <button type="button" className="pill h-9" onClick={doSignOut}>
                <LogOut className="h-4 w-4" aria-hidden /> Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 bg-page/85 px-4 pb-3 pt-4 backdrop-blur-md lg:pl-2 lg:pr-6">
          <div className="flex items-center gap-3">
            <button className="pill-icon border border-slate-200 bg-surface lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
              <Menu className="h-4 w-4" />
            </button>
            <Link href="/" className="hidden h-11 items-center gap-2.5 rounded-full border border-slate-200 bg-surface pl-1.5 pr-4 sm:inline-flex">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-500 text-[11px] font-bold text-white">{initials(companyName)}</span>
              <span className="max-w-[12rem] truncate text-[13px] font-semibold text-slate-900">{companyName}</span>
            </Link>

            <div className="flex min-w-0 flex-1 justify-center">
              {sections.length > 0 && <PillNav key={sections.map((s) => s.href).join("|")} items={sections} ariaLabel="Section" variant="group" className="[&>nav]:h-11 [&>nav]:px-1.5" />}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {demoMode && (
                <span className="hidden rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 md:inline" title="Integrations without credentials use synthetic demo data">
                  Demo mode
                </span>
              )}
              <div className="pill-group h-11 px-1.5">
                <SearchCommand />
                <Link href="/helpdesk/notifications" className="relative pill-icon" aria-label={unreadNotifications ? `Notifications (${unreadNotifications} unread)` : "Notifications"} title="Notifications">
                  <Bell className="h-4 w-4" />
                  {unreadNotifications > 0 && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-brand-500 ring-2 ring-surface" data-testid="notification-count" aria-label={`${unreadNotifications} unread`} />}
                </Link>
                <Link href="/account/security" className="pill-icon" aria-label="Security" title="Security">
                  <ShieldCheck className="h-4 w-4" />
                </Link>
              </div>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="inline-flex h-11 items-center gap-2.5 rounded-full border border-slate-200 bg-surface pl-1.5 pr-3 text-left outline-none transition-colors hover:bg-slate-50" aria-label="Account menu">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-700">{initials(user.name)}</span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block max-w-[10rem] truncate text-[13px] font-semibold leading-4 text-slate-900">{user.name}</span>
                    <span className="block max-w-[10rem] truncate text-[11px] leading-4 text-slate-500">{ROLE_LABELS[user.role]}</span>
                  </span>
                  <ChevronDown className="hidden h-3.5 w-3.5 text-slate-400 sm:block" aria-hidden />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={8} className="menu min-w-[220px]">
                    <div className="px-2.5 py-2">
                      <div className="truncate text-[13px] font-semibold text-slate-900">{user.name}</div>
                      <div className="truncate text-xs text-slate-500">{user.email}</div>
                    </div>
                    <DropdownMenu.Separator className="my-1 h-px bg-slate-100" />
                    <DropdownMenu.Item asChild>
                      <Link href="/account/security" className="menu-item">
                        <ShieldCheck className="h-4 w-4" aria-hidden /> Account security
                      </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                      <Link href="/helpdesk/notifications" className="menu-item">
                        <Bell className="h-4 w-4" aria-hidden /> Notifications
                        {unreadNotifications > 0 && <span className="ml-auto rounded-full bg-brand-50 px-1.5 text-[11px] font-medium text-brand-700">{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>}
                      </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                      <Link href="/helpdesk" className="menu-item">
                        <LifeBuoy className="h-4 w-4" aria-hidden /> Helpdesk
                      </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-slate-100" />
                    <DropdownMenu.Item className="menu-item" onSelect={doSignOut}>
                      <LogOut className="h-4 w-4" aria-hidden /> Sign out
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
        </header>
        {twoFactorDueBy && (
          <div className="mx-4 mb-2 rounded-xl bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800 lg:ml-2 lg:mr-6">
            Two-factor authentication is required for your role from {twoFactorDueBy}.{" "}
            <Link href="/account/security" className="font-medium underline">
              Set it up now
            </Link>
          </div>
        )}
        <ThemeSync pref={user.theme} />
        <ToastProvider>
          <main className="flex-1 px-4 pb-12 pt-3 lg:pl-2 lg:pr-6">
            <PageTransition>{children}</PageTransition>
          </main>
        </ToastProvider>
      </div>
    </div>
  );
}

/** Horizontal variant of the theme cluster for the mobile drawer. */
function ThemeRailInline({ initial }: { initial: ThemePref }) {
  return (
    <div className="[&>div]:flex-row">
      <ThemeRail initial={initial} />
    </div>
  );
}
