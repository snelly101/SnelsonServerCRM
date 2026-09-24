"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitMerge, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import {
  mergePreviewAction,
  mergeTicketsAction,
  splitTicketAction,
} from "@/actions/helpdesk";

type Preview = {
  target: {
    id: string;
    reference: string;
    subject: string;
    status: string;
    requesterEmail: string | null;
  };
  sources: {
    id: string;
    reference: string;
    subject: string;
    status: string;
    requesterEmail: string | null;
    messages: number;
    newParticipants: string[];
    differentRequester: boolean;
    timeMinutes: number;
  }[];
};

/** Merge THIS ticket into another one (this ticket closes and points at the survivor). */
export function MergeDialog({
  ticketId,
  reference,
}: {
  ticketId: string;
  reference: string;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const load = () =>
    start(async () => {
      const r = await mergePreviewAction([ticketId], target);
      if (r.ok) {
        setPreview(r.data);
        setError(null);
      } else {
        setPreview(null);
        setError(r.error);
      }
    });
  const confirm = () =>
    start(async () => {
      if (!preview) return;
      const r = await mergeTicketsAction([ticketId], preview.target.id);
      if (r.ok) {
        setOpen(false);
        router.push(`/helpdesk/tickets/${r.data.targetId}`);
        router.refresh();
      } else setError(r.error);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPreview(null);
          setError(null);
        }
      }}
    >
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <GitMerge className="h-3.5 w-3.5" /> Merge
      </Button>
      <DialogContent
        title={`Merge ${reference} into another ticket`}
        description="The conversation, participants, attachments and time move to the surviving ticket. This ticket closes and later replies to its reference reach the survivor."
        wide
      >
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <Field
              label="Merge into (reference)"
              htmlFor="mg-target"
              className="flex-1"
            >
              <Input
                id="mg-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="IT-000123"
                autoFocus
              />
            </Field>
            <Button
              variant="secondary"
              loading={pending}
              onClick={load}
              disabled={!target.trim()}
            >
              Preview
            </Button>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          {preview && (
            <div
              className="rounded-md border border-slate-200 p-3 text-sm"
              aria-live="polite"
            >
              <p className="mb-2">
                Surviving ticket: <strong>{preview.target.reference}</strong>{" "}
                {preview.target.subject} <Badge>{preview.target.status}</Badge>
              </p>
              <ul className="space-y-1">
                {preview.sources.map((s) => (
                  <li key={s.id}>
                    <strong>{s.reference}</strong> {s.subject}: {s.messages}{" "}
                    message{s.messages === 1 ? "" : "s"}, {s.timeMinutes} min of
                    time
                    {s.newParticipants.length > 0 && (
                      <>, adds CC {s.newParticipants.join(", ")}</>
                    )}
                    {s.differentRequester && (
                      <Badge className="ml-1" tone="amber">
                        different requester ({s.requesterEmail})
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Back
                </Button>
                <Button loading={pending} onClick={confirm}>
                  Merge into {preview.target.reference}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SplitDialog({
  ticketId,
  subject,
  messages,
}: {
  ticketId: string;
  subject: string;
  messages: { id: string; label: string; kind: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [newSubject, setNewSubject] = useState(subject);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const go = () =>
    start(async () => {
      const r = await splitTicketAction(ticketId, {
        messageIds: [...chosen],
        subject: newSubject,
      });
      if (r.ok) {
        setOpen(false);
        router.push(`/helpdesk/tickets/${r.data.newTicketId}`);
        router.refresh();
      } else setError(r.error);
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        disabled={messages.length < 2}
      >
        <Scissors className="h-3.5 w-3.5" /> Split
      </Button>
      <DialogContent
        title="Split messages into a new ticket"
        description="Choose the messages that belong to a separate issue. They move to a new ticket for the same requester, linked back to this one."
        wide
      >
        <div className="space-y-3">
          <Field label="New ticket subject" htmlFor="sp-subject">
            <Input
              id="sp-subject"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
            />
          </Field>
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 text-sm">
            {messages.map((m) => (
              <li key={m.id}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                    checked={chosen.has(m.id)}
                    onChange={() => toggle(m.id)}
                  />
                  <span>
                    <Badge tone={m.kind === "internal" ? "amber" : "slate"}>
                      {m.kind}
                    </Badge>{" "}
                    {m.label}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end">
            <Button
              loading={pending}
              disabled={
                chosen.size === 0 ||
                chosen.size >= messages.length ||
                !newSubject.trim()
              }
              onClick={go}
            >
              Move {chosen.size} message{chosen.size === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
