"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Building2, Search, User, LifeBuoy, BookOpen, CornerDownLeft } from "lucide-react";
import type { SearchHit } from "@/services/search";
import { cn } from "@/lib/utils";

const ICONS = { company: Building2, ticket: LifeBuoy, article: BookOpen, contact: User } as const;

/** The search field and its result list; used inside the command dialog. */
export function GlobalSearch({ onNavigate, autoFocus }: { onNavigate?: () => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) {
          const data = (await res.json()) as { hits: SearchHit[] };
          setHits(data.hits);
          setActive(0);
        }
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (hit: SearchHit) => {
    onNavigate?.();
    setQ("");
    router.push(hit.href);
  };
  const searched = q.trim().length >= 2;

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={searched}
          aria-controls="global-search-results"
          aria-label="Search companies and contacts"
          className="h-12 w-full rounded-t-2xl bg-transparent pl-11 pr-4 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 focus-visible:outline-none"
          placeholder="Search companies, contacts, tickets, articles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && hits[active]) {
              e.preventDefault();
              go(hits[active]);
            }
          }}
        />
      </div>
      <ul id="global-search-results" role="listbox" className={cn("max-h-80 overflow-y-auto border-t border-slate-100 p-1.5", !searched && "hidden")}>
        {loading && hits.length === 0 && <li className="px-3 py-2 text-[13px] text-slate-500">Searching…</li>}
        {!loading && searched && hits.length === 0 && <li className="px-3 py-2 text-[13px] text-slate-500">No results for “{q}”</li>}
        {hits.map((h, i) => {
          const Icon = ICONS[h.type as keyof typeof ICONS] ?? User;
          return (
            <li
              key={`${h.type}-${h.id}`}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px]", i === active ? "bg-slate-100" : "")}
              onMouseDown={() => go(h)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-50 text-slate-500">
                <Icon className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-slate-900">{h.title}</span>
                {h.subtitle && <span className="text-slate-500"> · {h.subtitle}</span>}
              </span>
              {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The search icon in the top bar; opens a command-style dialog. Ctrl/⌘ K opens it from anywhere. */
export function SearchCommand() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger className="pill-icon" aria-label="Search (Ctrl K)" title="Search · Ctrl K">
        <Search className="h-4 w-4" aria-hidden />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 animate-fade bg-slate-950/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 animate-fade rounded-2xl border border-slate-200 bg-surface shadow-pop focus:outline-none">
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <GlobalSearch autoFocus onNavigate={() => setOpen(false)} />
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            <span>Companies, contacts, tickets and help articles</span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans">↑↓</kbd> move <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans">↵</kbd> open <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans">esc</kbd> close
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
