"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Link2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { linkArticleAction, unlinkArticleAction } from "@/actions/helpdesk-kb";

export type LinkedArticle = {
  id: string;
  title: string;
  slug: string;
  status: string;
  customerVisible: boolean;
  kind: string;
};
export type SuggestedArticle = {
  id: string;
  title: string;
  slug: string;
  customerVisible: boolean;
  excerpt: string;
};

/** Linked and suggested knowledge articles for a ticket. */
export function KnowledgePanel({
  ticketId,
  linked,
  suggested,
  options,
  editable,
}: {
  ticketId: string;
  linked: LinkedArticle[];
  suggested: SuggestedArticle[];
  options: { id: string; title: string; category: string | null }[];
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-3 text-sm" aria-label="Knowledge">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Knowledge</h3>
        {editable && (
          <Link href={`/helpdesk/kb/new?ticket=${ticketId}`} className="text-xs text-brand-700 hover:underline">
            Write article
          </Link>
        )}
      </div>
      {error && <p className="mb-1 text-xs text-red-700">{error}</p>}
      <ul className="space-y-1 text-xs">
        {linked.map((a) => (
          <li key={a.id} className="flex items-center gap-1">
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <Link href={`/helpdesk/kb/${a.slug}`} className="min-w-0 flex-1 truncate text-brand-700 hover:underline">
              {a.title}
            </Link>
            {a.kind === "sent" && <Badge tone="green">sent</Badge>}
            {a.kind === "created_from" && <Badge tone="blue">from this ticket</Badge>}
            {a.status !== "published" && <Badge tone="amber">{a.status}</Badge>}
            {editable && (
              <button type="button" aria-label={`Unlink ${a.title}`} className="text-slate-400 hover:text-red-700" onClick={() => run(() => unlinkArticleAction(ticketId, a.id))}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {linked.length === 0 && <li className="text-slate-400">No articles linked.</li>}
      </ul>
      {suggested.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Suggested by subject</p>
          <ul className="space-y-1 text-xs">
            {suggested.map((s) => (
              <li key={s.id} className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <Link href={`/helpdesk/kb/${s.slug}`} className="text-slate-800 hover:text-brand-700">
                    {s.title}
                  </Link>
                  <p className="truncate text-slate-400">{s.excerpt}</p>
                </div>
                {editable && (
                  <button type="button" title="Link to this ticket" aria-label={`Link ${s.title}`} className="text-slate-400 hover:text-brand-700" onClick={() => run(() => linkArticleAction(ticketId, s.id))}>
                    <Link2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {editable && options.length > 0 && (
        <div className="mt-2 flex items-center gap-1">
          <Select
            aria-label="Link an article"
            className="h-8 text-xs"
            value=""
            disabled={pending}
            onChange={(e) => {
              if (e.target.value) run(() => linkArticleAction(ticketId, e.target.value));
            }}
          >
            <option value="">Link an article…</option>
            {options
              .filter((o) => !linked.some((l) => l.id === o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.category ? `${o.category}: ` : ""}
                  {o.title}
                </option>
              ))}
          </Select>
        </div>
      )}
    </section>
  );
}
