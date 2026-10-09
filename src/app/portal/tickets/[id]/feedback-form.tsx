"use client";

import { useActionState, useState } from "react";
import { Star } from "lucide-react";
import { SubmitButton, Textarea, FormMessage } from "@/components/ui/form";
import { portalFeedbackAction } from "@/actions/portal";

export function FeedbackForm({ ticketId, existing }: { ticketId: string; existing: { rating: number; comment: string | null } | null }) {
  const [result, formAction] = useActionState(portalFeedbackAction.bind(null, ticketId), null);
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [open, setOpen] = useState(!existing);
  if (!open)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-surface px-4 py-3 text-sm">
        <span className="text-slate-700">
          Thanks for rating this request {Array.from({ length: 5 }, (_, i) => <Star key={i} className={`inline h-4 w-4 ${i < (existing?.rating ?? 0) ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />)}
        </span>
        <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(true)}>Change</button>
      </div>
    );
  return (
    <form action={formAction} className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/40 px-4 py-3">
      <FormMessage result={result} />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-slate-800">How did we do?</span>
        <span className="flex items-center gap-0.5" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} out of 5`} onClick={() => setRating(n)} className="rounded p-0.5 hover:bg-indigo-100">
              <Star className={`h-6 w-6 ${n <= rating ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
            </button>
          ))}
        </span>
        <input type="hidden" name="rating" value={rating} />
      </div>
      {rating > 0 && (
        <>
          <Textarea name="comment" rows={2} placeholder="Anything we could do better? (optional)" defaultValue={existing?.comment ?? ""} maxLength={2000} />
          <div className="flex justify-end"><SubmitButton size="sm">Send rating</SubmitButton></div>
        </>
      )}
    </form>
  );
}
