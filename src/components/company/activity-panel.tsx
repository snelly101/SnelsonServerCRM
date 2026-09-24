"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NoteForm } from "@/components/note-form";
import { ActivityRows, type TimelineItem } from "@/components/timeline";

/**
 * Activity section: the timeline plus the logging workflow, which stays
 * collapsed until "Log activity" is pressed. Saving goes through the existing
 * NoteForm action and refresh.
 */
export function ActivityPanel({ companyId, items, contacts, canWrite }: { companyId: string; items: TimelineItem[]; contacts: { id: string; name: string }[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="activity-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="activity-heading" className="text-sm font-semibold text-slate-800">
          Activity
        </h2>
        {canWrite && (
          <Button size="sm" variant={open ? "secondary" : "primary"} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="activity-form">
            {open ? <X className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} {open ? "Close" : "Log activity"}
          </Button>
        )}
      </div>
      {canWrite && open && (
        <div id="activity-form" className="mb-3 rounded-md border border-slate-200 bg-surface p-4">
          <NoteForm companyId={companyId} contacts={contacts} />
        </div>
      )}
      <div className="rounded-md border border-slate-200 bg-surface">
        <ActivityRows items={items} />
      </div>
    </section>
  );
}
