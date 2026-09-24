"use client";

import { useEffect, useState, useTransition } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { setThemeAction } from "@/actions/account";
import { THEME_COOKIE, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Applies a preference to the document immediately; the server action persists it. */
export function applyTheme(pref: ThemePref) {
  const d = document.documentElement;
  d.setAttribute("data-theme-pref", pref);
  d.setAttribute("data-theme", pref === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref);
}

export function ThemeToggle({ initial }: { initial: ThemePref }) {
  const [pref, setPref] = useState<ThemePref>(initial);
  const [pending, start] = useTransition();
  const current = OPTIONS.find((o) => o.value === pref) ?? OPTIONS[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="rounded p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`Theme: ${current.label}`} title="Theme">
        <current.Icon className="h-4 w-4" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-40 min-w-[150px] rounded-md border border-slate-200 bg-surface p-1 shadow-lg">
          {OPTIONS.map((o) => (
            <DropdownMenu.Item
              key={o.value}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 outline-none data-[highlighted]:bg-slate-100"
              disabled={pending}
              onSelect={() => {
                setPref(o.value);
                applyTheme(o.value);
                start(async () => {
                  await setThemeAction(o.value);
                });
              }}
            >
              <o.Icon className="h-4 w-4" aria-hidden /> {o.label}
              {o.value === pref && <Check className="ml-auto h-3.5 w-3.5" aria-hidden />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** On a device with no theme cookie yet, applies the preference saved on the user's account. */
export function ThemeSync({ pref }: { pref: ThemePref }) {
  useEffect(() => {
    if (document.cookie.split("; ").some((c) => c.startsWith(`${THEME_COOKIE}=`))) return;
    if (pref !== "system") {
      applyTheme(pref);
      document.cookie = `${THEME_COOKIE}=${pref}; path=/; max-age=${365 * 24 * 3600}; samesite=lax`;
    }
  }, [pref]);
  return null;
}
