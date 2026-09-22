"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, X, Bookmark, Trash2 } from "lucide-react";
import { Input, Select } from "./form";
import { Button } from "./button";
import { saveViewAction, deleteViewAction } from "@/actions/admin";

export type FilterDef = { key: string; label: string; options: { value: string; label: string }[] };
export type SavedView = { id: string; name: string; params: Record<string, string>; userId: string; isShared: boolean };

/**
 * URL-driven filter bar. Every filter is a search param so views are
 * bookmarkable, shareable and can be saved as named views.
 */
export function FilterBar({ page, filters, savedViews, currentUserId, placeholder = "Search…" }: { page: string; filters: FilterDef[]; savedViews: SavedView[]; currentUserId: string; placeholder?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [pending, start] = useTransition();
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState("");

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    start(() => router.push(`${pathname}?${next.toString()}`));
  };

  const activeCount = [...sp.keys()].filter((k) => !["page", "sort", "dir"].includes(k)).length;
  const currentParams: Record<string, string> = {};
  sp.forEach((v, k) => {
    if (k !== "page") currentParams[k] = v;
  });

  return (
    <div className="mb-4 space-y-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q });
        }}
      >
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <Input aria-label="Search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        {filters.map((f) => (
          <Select key={f.key} aria-label={f.label} value={sp.get(f.key) ?? ""} onChange={(e) => update({ [f.key]: e.target.value })} className="w-auto">
            <option value="">{f.label}: all</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ))}
        <Button type="submit" variant="secondary" loading={pending}>
          Apply
        </Button>
        {activeCount > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              setQ("");
              start(() => router.push(pathname));
            }}
          >
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
        {activeCount > 0 && !saving && (
          <Button variant="ghost" onClick={() => setSaving(true)}>
            <Bookmark className="h-4 w-4" /> Save view
          </Button>
        )}
      </form>
      {saving && (
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await saveViewAction({ page, name: viewName, params: currentParams });
            if (res.ok) {
              setSaving(false);
              setViewName("");
              router.refresh();
            }
          }}
        >
          <Input aria-label="View name" placeholder="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} className="max-w-xs" required />
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSaving(false)}>
            Cancel
          </Button>
        </form>
      )}
      {savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-slate-500">Saved views:</span>
          {savedViews.map((v) => (
            <span key={v.id} className="inline-flex items-center rounded-full border border-slate-200 bg-white">
              <button type="button" className="px-2 py-0.5 hover:text-brand-700" onClick={() => start(() => router.push(`${pathname}?${new URLSearchParams(v.params).toString()}`))}>
                {v.name}
              </button>
              {v.userId === currentUserId && (
                <button
                  type="button"
                  aria-label={`Delete view ${v.name}`}
                  className="px-1.5 text-slate-400 hover:text-red-600"
                  onClick={async () => {
                    await deleteViewAction(v.id, page);
                    router.refresh();
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
