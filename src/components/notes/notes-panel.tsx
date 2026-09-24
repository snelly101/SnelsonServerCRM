"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pin, PinOff, Archive, ArchiveRestore, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page";
import { MarkdownLite } from "@/lib/markdown-lite";
import { archiveNoteAction, pinNoteAction } from "@/actions/notes";
import { NoteDialog } from "./note-dialog";

export type NoteRow = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  archivedAt: string | null;
  updatedAt: string;
  updatedByName: string | null;
};

export function NotesPanel({
  companyId,
  notes,
  canWrite,
  showArchived,
}: {
  companyId: string;
  notes: NoteRow[];
  canWrite: boolean;
  showArchived: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  const live = notes.filter((n) => !n.archivedAt);
  const archived = notes.filter((n) => n.archivedAt);
  return (
    <section aria-labelledby="notes-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="notes-heading" className="text-sm font-semibold text-slate-800">
          Notes
        </h2>
        <div className="flex items-center gap-3">
          <a
            href={
              showArchived
                ? `/companies/${companyId}?tab=notes`
                : `/companies/${companyId}?tab=notes&archived=1`
            }
            className="text-xs text-slate-500 hover:underline"
          >
            {showArchived
              ? "Hide archived"
              : `Show archived${archived.length ? ` (${archived.length})` : ""}`}
          </a>
          {canWrite && <NoteDialog companyId={companyId} />}
        </div>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {live.length === 0 && !showArchived && (
        <EmptyState
          title="No notes yet"
          description="Keep standing information here: site access, escalation contacts, preferences, quirks. Pin the important ones to the Overview."
          action={canWrite ? <NoteDialog companyId={companyId} /> : undefined}
        />
      )}
      <ul className={`space-y-3 ${pending ? "opacity-70" : ""}`}>
        {(showArchived ? notes : live).map((n) => (
          <li
            key={n.id}
            className={`rounded-md border bg-white ${n.archivedAt ? "border-dashed border-slate-300" : "border-slate-200"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-2">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
                  {n.title}
                  {n.pinned && !n.archivedAt && (
                    <Badge tone="indigo">pinned</Badge>
                  )}
                  {n.archivedAt && <Badge>archived</Badge>}
                </h3>
                <div className="text-[11px] text-slate-500">
                  Edited {n.updatedAt}
                  {n.updatedByName ? ` by ${n.updatedByName}` : ""}
                </div>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-1">
                  {!n.archivedAt && (
                    <>
                      <NoteDialog
                        companyId={companyId}
                        note={{
                          id: n.id,
                          title: n.title,
                          body: n.body,
                          pinned: n.pinned,
                        }}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Edit ${n.title}`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                          </Button>
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={
                          n.pinned ? `Unpin ${n.title}` : `Pin ${n.title}`
                        }
                        onClick={() =>
                          run(() => pinNoteAction(n.id, !n.pinned))
                        }
                      >
                        {n.pinned ? (
                          <PinOff className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Pin className="h-3.5 w-3.5" aria-hidden />
                        )}{" "}
                        {n.pinned ? "Unpin" : "Pin"}
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={
                      n.archivedAt ? `Restore ${n.title}` : `Archive ${n.title}`
                    }
                    onClick={() =>
                      run(() => archiveNoteAction(n.id, Boolean(n.archivedAt)))
                    }
                  >
                    {n.archivedAt ? (
                      <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Archive className="h-3.5 w-3.5" aria-hidden />
                    )}{" "}
                    {n.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              )}
            </div>
            <div className="px-4 py-3">
              {n.body.trim() ? (
                <MarkdownLite text={n.body} />
              ) : (
                <p className="text-[13px] text-slate-400">Empty note.</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
