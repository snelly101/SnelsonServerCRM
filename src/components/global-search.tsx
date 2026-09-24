"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Search, User, LifeBuoy, BookOpen } from "lucide-react";
import type { SearchHit } from "@/services/search";

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          setOpen(true);
        }
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQ("");
    router.push(hit.href);
  };

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-label="Search companies and contacts"
        className="input pl-8 pr-14"
        placeholder="Search companies, contacts…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            go(hits[active]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <kbd className="pointer-events-none absolute right-2.5 top-2 hidden rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] text-slate-500 sm:block">Ctrl K</kbd>
      {open && (
        <ul id="global-search-results" role="listbox" className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-surface shadow-lg">
          {loading && hits.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {!loading && hits.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No results for “{q}”</li>}
          {hits.map((h, i) => (
            <li
              key={`${h.type}-${h.id}`}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${i === active ? "bg-brand-50" : ""}`}
              onMouseDown={() => go(h)}
              onMouseEnter={() => setActive(i)}
            >
              {h.type === "company" ? <Building2 className="h-4 w-4 text-slate-400" /> : h.type === "ticket" ? <LifeBuoy className="h-4 w-4 text-slate-400" /> : h.type === "article" ? <BookOpen className="h-4 w-4 text-slate-400" /> : <User className="h-4 w-4 text-slate-400" />}
              <span className="font-medium text-slate-800">{h.title}</span>
              {h.subtitle && <span className="truncate text-slate-500">· {h.subtitle}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
