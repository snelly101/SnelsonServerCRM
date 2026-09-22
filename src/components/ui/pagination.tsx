"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClass } from "./button";

export function Pagination({ page, pageCount, total, pageSize }: { page: number; pageCount: number; total: number; pageSize: number }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const link = (p: number) => {
    const next = new URLSearchParams(sp.toString());
    next.set("page", String(p));
    return `${pathname}?${next.toString()}`;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-slate-600">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={link(page - 1)} className={buttonClass("secondary", "sm")} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Link>
        ) : (
          <span className={buttonClass("secondary", "sm", "opacity-50")}>
            <ChevronLeft className="h-4 w-4" />
          </span>
        )}
        <span className="px-2">
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? (
          <Link href={link(page + 1)} className={buttonClass("secondary", "sm")} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <span className={buttonClass("secondary", "sm", "opacity-50")}>
            <ChevronRight className="h-4 w-4" />
          </span>
        )}
      </div>
    </div>
  );
}

export function SortLink({ column, label }: { column: string; label: string }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const current = sp.get("sort") ?? "name";
  const dir = sp.get("dir") ?? "asc";
  const next = new URLSearchParams(sp.toString());
  next.set("sort", column);
  next.set("dir", current === column && dir === "asc" ? "desc" : "asc");
  next.delete("page");
  const active = current === column;
  return (
    <Link href={`${pathname}?${next.toString()}`} className="inline-flex items-center gap-1 hover:text-slate-800">
      {label}
      {active && <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>}
    </Link>
  );
}
