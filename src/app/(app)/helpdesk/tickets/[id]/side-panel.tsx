"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Pencil,
  UserCheck,
  UserMinus,
  Timer,
  Square,
  Trash2,
  Link2,
  Bell,
  BellOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  Textarea,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import {
  StatusBadge,
  PriorityBadge,
  TypeBadge,
  dueLabel,
} from "@/components/helpdesk/badges";
import {
  addParticipantAction,
  addTimeEntryAction,
  assignTicketAction,
  changeStatusAction,
  deleteTimeEntryAction,
  followTicketAction,
  linkTicketAction,
  removeParticipantAction,
  timerAction,
  unlinkTicketAction,
  updateTicketFieldsAction,
} from "@/actions/helpdesk";
import {
  RESOLUTION_CATEGORIES,
  RESOLUTION_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  type TicketStatus,
} from "@/lib/validation-helpdesk";
import { fmtDateTime, fmtRelative, type DisplaySettings } from "@/lib/format";
import { TRANSITIONS } from "@/lib/helpdesk-transitions";

type Option = { id: string; name: string };
export type SidePanelTicket = {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  type: string;
  source: string;
  version: number;
  tags: string[];
  categoryId: string | null;
  subcategoryId: string | null;
  categoryName: string | null;
  subcategoryName: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterContactId: string | null;
  requesterUnverified: boolean;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    jobTitle: string | null;
  } | null;
  companyId: string | null;
  companyName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  teamId: string | null;
  teamName: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  createdAt: Date;
  creatorName: string | null;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  reopenCount: number;
  resolutionSummary: string | null;
  resolutionCategory: string | null;
  timeSpentMinutes: number;
  customFields: Record<string, unknown>;
  mergedInto: { id: string; reference: string; subject: string } | null;
  parent: {
    id: string;
    reference: string;
    subject: string;
    status: string;
  } | null;
  children: {
    id: string;
    reference: string;
    subject: string;
    status: string;
  }[];
  links: {
    id: string;
    kind: string;
    direction: "in" | "out";
    ticketId: string;
    reference: string;
    subject: string;
    status: string;
  }[];
  participants: {
    id: string;
    role: string;
    name: string | null;
    email: string | null;
    contactId: string | null;
    userId: string | null;
    userName: string | null;
  }[];
  timeEntries: {
    id: string;
    userId: string;
    userName: string;
    minutes: number;
    note: string | null;
    billable: boolean;
    createdAt: Date;
  }[];
  timers: { userId: string; userName: string; startedAt: Date }[];
};
type CustomFieldDef = {
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  required: boolean;
};

const minutes = (n: number) =>
  n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`;

export function SidePanel({
  t,
  me,
  canEdit,
  canManage,
  agents,
  teams,
  categories,
  companies,
  contacts,
  customFields,
  settings,
}: {
  t: SidePanelTicket;
  me: { id: string; name: string };
  canEdit: boolean;
  canManage: boolean;
  agents: Option[];
  teams: Option[];
  categories: (Option & { children: Option[] })[];
  companies: Option[];
  contacts: (Option & { companyId: string })[];
  customFields: CustomFieldDef[];
  settings: DisplaySettings;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  const following = t.participants.some(
    (p) => p.role === "follower" && p.userId === me.id,
  );
  const myTimer = t.timers.find((x) => x.userId === me.id);
  const frDue = dueLabel(t.firstResponseDueAt, Boolean(t.firstResponseAt));
  const resDue = dueLabel(t.resolutionDueAt, Boolean(t.resolvedAt));
  const merged = Boolean(t.mergedInto);
  const editable = canEdit && !merged;
  return (
    <aside className="space-y-4 text-sm" aria-label="Ticket details">
      {msg && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {msg}
        </p>
      )}
      <section className="rounded-lg border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Status
          </h3>
          {editable && <StatusDialog t={t} />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={t.status} />
          <PriorityBadge priority={t.priority} />
          <TypeBadge type={t.type} />
          {t.needsReview && (
            <Badge tone="amber" className="cursor-help">
              review: {t.reviewReason ?? "check the requester"}
            </Badge>
          )}
        </div>
        <dl className="mt-2 space-y-1 text-xs text-slate-600">
          <div className="flex justify-between gap-2">
            <dt>First response</dt>
            <dd>
              {t.firstResponseAt ? (
                fmtDateTime(t.firstResponseAt, settings)
              ) : frDue ? (
                <Badge tone={frDue.tone}>{frDue.text}</Badge>
              ) : (
                <span className="text-slate-400">no target</span>
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Resolution</dt>
            <dd>
              {t.resolvedAt ? (
                fmtDateTime(t.resolvedAt, settings)
              ) : resDue ? (
                <Badge tone={resDue.tone}>{resDue.text}</Badge>
              ) : (
                <span className="text-slate-400">no target</span>
              )}
            </dd>
          </div>
          {t.closedAt && (
            <div className="flex justify-between gap-2">
              <dt>Closed</dt>
              <dd>{fmtDateTime(t.closedAt, settings)}</dd>
            </div>
          )}
          {t.reopenCount > 0 && (
            <div className="flex justify-between gap-2">
              <dt>Reopened</dt>
              <dd>{t.reopenCount}×</dd>
            </div>
          )}
        </dl>
        {t.resolutionSummary && (
          <div className="mt-2 rounded bg-green-50 px-2 py-1.5 text-xs text-green-900">
            <div className="font-medium">
              Resolution
              {t.resolutionCategory
                ? ` · ${RESOLUTION_CATEGORY_LABELS[t.resolutionCategory as keyof typeof RESOLUTION_CATEGORY_LABELS] ?? t.resolutionCategory}`
                : ""}
            </div>
            <div className="whitespace-pre-wrap">{t.resolutionSummary}</div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Assignment
          </h3>
          {editable && (
            <span className="flex gap-1">
              {t.assigneeUserId !== me.id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() =>
                    run(() =>
                      assignTicketAction(t.id, { assigneeUserId: me.id }),
                    )
                  }
                  title="Assign to me"
                >
                  <UserCheck className="h-3.5 w-3.5" /> Take
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() =>
                    run(() =>
                      assignTicketAction(t.id, { assigneeUserId: null }),
                    )
                  }
                  title="Unassign"
                >
                  <UserMinus className="h-3.5 w-3.5" /> Release
                </Button>
              )}
            </span>
          )}
        </div>
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500">Agent</dt>
            <dd>
              {canManage && !merged ? (
                <Select
                  aria-label="Assignee"
                  className="h-8 w-auto max-w-[180px] text-xs"
                  value={t.assigneeUserId ?? ""}
                  onChange={(e) =>
                    run(() =>
                      assignTicketAction(t.id, {
                        assigneeUserId: e.target.value || null,
                      }),
                    )
                  }
                >
                  <option value="">unassigned</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              ) : (
                (t.assigneeName ?? (
                  <span className="text-amber-700">unassigned</span>
                ))
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500">Team</dt>
            <dd>
              {canManage && !merged ? (
                <Select
                  aria-label="Team"
                  className="h-8 w-auto max-w-[180px] text-xs"
                  value={t.teamId ?? ""}
                  onChange={(e) =>
                    run(() =>
                      assignTicketAction(t.id, {
                        teamId: e.target.value || null,
                      }),
                    )
                  }
                >
                  <option value="">none</option>
                  {teams.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              ) : (
                (t.teamName ?? "—")
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-slate-500">
            {t.participants.filter((p) => p.role === "follower").length}{" "}
            following
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run(() => followTicketAction(t.id, !following))}
          >
            {following ? (
              <>
                <BellOff className="h-3.5 w-3.5" /> Unfollow
              </>
            ) : (
              <>
                <Bell className="h-3.5 w-3.5" /> Follow
              </>
            )}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Requester
          </h3>
          {editable && (
            <FieldsDialog
              t={t}
              agents={agents}
              teams={teams}
              categories={categories}
              companies={companies}
              contacts={contacts}
              customFields={customFields}
            />
          )}
        </div>
        <div className="font-medium">
          {t.requesterName ?? t.requesterEmail ?? "Unknown"}
          {t.requesterUnverified && (
            <Badge className="ml-1" tone="amber">
              unverified
            </Badge>
          )}
        </div>
        {t.requesterEmail && (
          <div className="text-xs text-slate-600">{t.requesterEmail}</div>
        )}
        {t.contact && (
          <div className="text-xs text-slate-600">
            <Link
              href={`/contacts/${t.contact.id}`}
              className="text-brand-700 hover:underline"
            >
              {t.contact.name}
            </Link>
            {t.contact.jobTitle && ` · ${t.contact.jobTitle}`}
            {t.contact.phone && ` · ${t.contact.phone}`}
          </div>
        )}
        <div className="mt-1 text-xs text-slate-600">
          {t.companyId ? (
            <Link
              href={`/companies/${t.companyId}?tab=tickets`}
              className="text-brand-700 hover:underline"
            >
              {t.companyName}
            </Link>
          ) : (
            <span className="text-slate-400">No company linked</span>
          )}
        </div>
        <dl className="mt-2 space-y-1 text-xs text-slate-600">
          <div className="flex justify-between gap-2">
            <dt>Category</dt>
            <dd>
              {t.categoryName
                ? `${t.categoryName}${t.subcategoryName ? ` › ${t.subcategoryName}` : ""}`
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Source</dt>
            <dd>{t.source}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Created</dt>
            <dd title={new Date(t.createdAt).toISOString()}>
              {fmtRelative(t.createdAt)}
              {t.creatorName ? ` by ${t.creatorName}` : ""}
            </dd>
          </div>
          {t.tags.length > 0 && (
            <div className="flex justify-between gap-2">
              <dt>Tags</dt>
              <dd className="flex flex-wrap justify-end gap-1">
                {t.tags.map((x) => (
                  <Badge key={x}>{x}</Badge>
                ))}
              </dd>
            </div>
          )}
          {customFields.map((f) => (
            <div key={f.key} className="flex justify-between gap-2">
              <dt>{f.label}</dt>
              <dd>
                {t.customFields[f.key] === undefined ||
                t.customFields[f.key] === ""
                  ? "—"
                  : String(t.customFields[f.key])}
              </dd>
            </div>
          ))}
        </dl>
        <ParticipantsBlock t={t} editable={editable} run={run} />
      </section>

      <section className="rounded-lg border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Time · {minutes(t.timeSpentMinutes)}
          </h3>
          {editable && (
            <span className="flex gap-1">
              {myTimer ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() => run(() => timerAction(t.id, "stop"))}
                  title={`Running since ${fmtDateTime(myTimer.startedAt, settings)}`}
                >
                  <Square className="h-3.5 w-3.5" /> Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() => run(() => timerAction(t.id, "start"))}
                >
                  <Timer className="h-3.5 w-3.5" /> Start
                </Button>
              )}
              <TimeDialog ticketId={t.id} />
            </span>
          )}
        </div>
        {t.timers
          .filter((x) => x.userId !== me.id)
          .map((x) => (
            <p key={x.userId} className="text-xs text-slate-500">
              {x.userName} has a timer running since {fmtRelative(x.startedAt)}
            </p>
          ))}
        {t.timeEntries.length === 0 ? (
          <p className="text-xs text-slate-400">No time logged.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {t.timeEntries.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="w-12 tabular-nums">{minutes(e.minutes)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {e.userName}
                  {e.note ? ` · ${e.note}` : ""}
                  {!e.billable && " · non-billable"}
                </span>
                {(e.userId === me.id || canManage) && !merged && (
                  <button
                    type="button"
                    aria-label="Remove time entry"
                    className="text-slate-400 hover:text-red-700"
                    onClick={() => run(() => deleteTimeEntryAction(t.id, e.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Linked tickets
          </h3>
          {editable && <LinkDialog ticketId={t.id} />}
        </div>
        {t.mergedInto && (
          <p className="mb-1 text-xs">
            Merged into{" "}
            <Link
              href={`/helpdesk/tickets/${t.mergedInto.id}`}
              className="text-brand-700 hover:underline"
            >
              {t.mergedInto.reference}
            </Link>
          </p>
        )}
        {t.parent && (
          <p className="mb-1 text-xs">
            Child of{" "}
            <Link
              href={`/helpdesk/tickets/${t.parent.id}`}
              className="text-brand-700 hover:underline"
            >
              {t.parent.reference}
            </Link>{" "}
            {t.parent.subject}
          </p>
        )}
        {t.children.map((c) => (
          <p key={c.id} className="text-xs">
            Child:{" "}
            <Link
              href={`/helpdesk/tickets/${c.id}`}
              className="text-brand-700 hover:underline"
            >
              {c.reference}
            </Link>{" "}
            {c.subject} <StatusBadge status={c.status} />
          </p>
        ))}
        {t.links.filter((l) => l.kind !== "parent").length === 0 &&
          !t.parent &&
          t.children.length === 0 &&
          !t.mergedInto && <p className="text-xs text-slate-400">None.</p>}
        <ul className="space-y-1 text-xs">
          {t.links
            .filter((l) => l.kind !== "parent")
            .map((l) => (
              <li key={l.id} className="flex items-center gap-1">
                <Badge tone="slate">
                  {l.kind.replace("_", " ")}
                  {l.direction === "in" && l.kind === "merged_from" ? "" : ""}
                </Badge>
                <Link
                  href={`/helpdesk/tickets/${l.ticketId}`}
                  className="text-brand-700 hover:underline"
                >
                  {l.reference}
                </Link>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {l.subject}
                </span>
                {editable &&
                  l.direction === "out" &&
                  l.kind !== "merged_from" &&
                  l.kind !== "split_from" && (
                    <button
                      type="button"
                      aria-label="Remove link"
                      className="text-slate-400 hover:text-red-700"
                      onClick={() => run(() => unlinkTicketAction(t.id, l.id))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
              </li>
            ))}
        </ul>
      </section>
    </aside>
  );
}

function ParticipantsBlock({
  t,
  editable,
  run,
}: {
  t: SidePanelTicket;
  editable: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const [result, formAction] = useActionState(
    addParticipantAction.bind(null, t.id),
    null,
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (result?.ok) setOpen(false);
  }, [result]);
  const ccs = t.participants.filter((p) => p.role === "cc");
  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">CC ({ccs.length})</span>
        {editable && (
          <button
            type="button"
            className="text-brand-700 hover:underline"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "cancel" : "add"}
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {ccs.map((p) => (
          <li key={p.id} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate">
              {p.name ? `${p.name} <${p.email}>` : p.email}
            </span>
            {editable && (
              <button
                type="button"
                aria-label={`Remove ${p.email}`}
                className="text-slate-400 hover:text-red-700"
                onClick={() => run(() => removeParticipantAction(t.id, p.id))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <form action={formAction} className="mt-2 space-y-1">
          <input type="hidden" name="role" value="cc" />
          <FormMessage result={result && !result.ok ? result : null} />
          <Input
            name="email"
            type="email"
            placeholder="person@customer.co.uk"
            aria-label="CC e-mail"
            required
            className="h-8 text-xs"
          />
          <Input
            name="name"
            placeholder="Name (optional)"
            aria-label="CC name"
            className="h-8 text-xs"
          />
          <SubmitButton size="sm">Add CC</SubmitButton>
        </form>
      )}
    </div>
  );
}

function StatusDialog({ t }: { t: SidePanelTicket }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TicketStatus>(t.status as TicketStatus);
  const [result, formAction] = useActionState(
    changeStatusAction.bind(null, t.id),
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const allowed = TRANSITIONS[t.status as TicketStatus] ?? [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setStatus(t.status as TicketStatus);
          setOpen(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" /> Change
      </Button>
      <DialogContent title={`Change status of ${t.reference}`}>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="version" value={t.version} />
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Status" htmlFor="st-status">
            <Select
              id="st-status"
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TicketStatus)}
            >
              <option value={t.status}>
                {TICKET_STATUS_LABELS[t.status as TicketStatus]} (current)
              </option>
              {TICKET_STATUSES.filter((s) => allowed.includes(s)).map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          {status === "resolved" && (
            <>
              <Field
                label="Resolution summary"
                htmlFor="st-summary"
                required
                error={fieldErrors(result, "resolutionSummary")}
                help="Sent to nobody automatically; shown on the ticket and the company timeline."
              >
                <Textarea
                  id="st-summary"
                  name="resolutionSummary"
                  rows={4}
                  defaultValue={t.resolutionSummary ?? ""}
                  required
                />
              </Field>
              <Field label="Resolution category" htmlFor="st-cat">
                <Select
                  id="st-cat"
                  name="resolutionCategory"
                  defaultValue={t.resolutionCategory ?? ""}
                >
                  <option value="">—</option>
                  {RESOLUTION_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {RESOLUTION_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <div className="flex justify-end">
            <SubmitButton disabled={status === t.status}>
              Update status
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldsDialog({
  t,
  agents,
  teams,
  categories,
  companies,
  contacts,
  customFields,
}: {
  t: SidePanelTicket;
  agents: Option[];
  teams: Option[];
  categories: (Option & { children: Option[] })[];
  companies: Option[];
  contacts: (Option & { companyId: string })[];
  customFields: CustomFieldDef[];
}) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(
    updateTicketFieldsAction.bind(null, t.id),
    null,
  );
  const [companyId, setCompanyId] = useState(t.companyId ?? "");
  const [contactId, setContactId] = useState(t.requesterContactId ?? "");
  const [categoryId, setCategoryId] = useState(t.categoryId ?? "");
  const router = useRouter();
  const e = (k: string) => fieldErrors(result, k);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const subs = categories.find((c) => c.id === categoryId)?.children ?? [];
  const visibleContacts = companyId
    ? contacts.filter((c) => c.companyId === companyId)
    : contacts;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5" /> Edit
      </Button>
      <DialogContent title={`Edit ${t.reference}`} wide>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="version" value={t.version} />
          <FormMessage result={result && !result.ok ? result : null} />
          <Field
            label="Subject"
            htmlFor="ef-subject"
            required
            error={e("subject")}
          >
            <Input
              id="ef-subject"
              name="subject"
              defaultValue={t.subject}
              required
              maxLength={300}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company" htmlFor="ef-company">
              <Select
                id="ef-company"
                name="companyId"
                value={companyId}
                onChange={(ev) => setCompanyId(ev.target.value)}
              >
                <option value="">—</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Requester (contact)"
              htmlFor="ef-contact"
              error={e("requesterContactId")}
            >
              <Select
                id="ef-contact"
                name="requesterContactId"
                value={contactId}
                onChange={(ev) => setContactId(ev.target.value)}
              >
                <option value="">—</option>
                {visibleContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {!contactId && (
              <>
                <Field label="Requester name" htmlFor="ef-rname">
                  <Input
                    id="ef-rname"
                    name="requesterName"
                    defaultValue={t.requesterName ?? ""}
                  />
                </Field>
                <Field
                  label="Requester e-mail"
                  htmlFor="ef-remail"
                  error={e("requesterEmail")}
                >
                  <Input
                    id="ef-remail"
                    name="requesterEmail"
                    type="email"
                    defaultValue={t.requesterEmail ?? ""}
                  />
                </Field>
              </>
            )}
            <Field label="Priority" htmlFor="ef-priority">
              <Select
                id="ef-priority"
                name="priority"
                defaultValue={t.priority}
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TICKET_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Type" htmlFor="ef-type">
              <Select id="ef-type" name="type" defaultValue={t.type}>
                {TICKET_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {TICKET_TYPE_LABELS[x]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="ef-category">
              <Select
                id="ef-category"
                name="categoryId"
                value={categoryId}
                onChange={(ev) => setCategoryId(ev.target.value)}
              >
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subcategory" htmlFor="ef-sub">
              <Select
                id="ef-sub"
                name="subcategoryId"
                defaultValue={t.subcategoryId ?? ""}
                disabled={subs.length === 0}
              >
                <option value="">—</option>
                {subs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Assignee" htmlFor="ef-assignee">
              <Select
                id="ef-assignee"
                name="assigneeUserId"
                defaultValue={t.assigneeUserId ?? ""}
              >
                <option value="">— unassigned —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team" htmlFor="ef-team">
              <Select id="ef-team" name="teamId" defaultValue={t.teamId ?? ""}>
                <option value="">—</option>
                {teams.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tags" htmlFor="ef-tags" help="Comma separated.">
              <Input
                id="ef-tags"
                name="tags"
                defaultValue={t.tags.join(", ")}
              />
            </Field>
            {customFields.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                htmlFor={`ef-cf-${f.key}`}
                required={f.required}
                error={e(`customFields.${f.key}`)}
              >
                {f.type === "select" ? (
                  <Select
                    id={`ef-cf-${f.key}`}
                    name={`cf.${f.key}`}
                    defaultValue={String(t.customFields[f.key] ?? "")}
                  >
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : f.type === "boolean" ? (
                  <Select
                    id={`ef-cf-${f.key}`}
                    name={`cf.${f.key}`}
                    defaultValue={String(t.customFields[f.key] ?? "")}
                  >
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                ) : (
                  <Input
                    id={`ef-cf-${f.key}`}
                    name={`cf.${f.key}`}
                    type={
                      f.type === "number"
                        ? "number"
                        : f.type === "date"
                          ? "date"
                          : "text"
                    }
                    defaultValue={String(t.customFields[f.key] ?? "")}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TimeDialog({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(
    addTimeEntryAction.bind(null, ticketId),
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Log
      </Button>
      <DialogContent title="Log time">
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Minutes"
              htmlFor="tm-min"
              required
              error={fieldErrors(result, "minutes")}
            >
              <Input
                id="tm-min"
                name="minutes"
                type="number"
                min={1}
                max={1440}
                required
                autoFocus
              />
            </Field>
            <Field label="Date" htmlFor="tm-date">
              <Input
                id="tm-date"
                name="date"
                type="date"
                defaultValue={new Date().toISOString().slice(0, 10)}
              />
            </Field>
          </div>
          <Field label="Note" htmlFor="tm-note">
            <Input id="tm-note" name="note" maxLength={500} />
          </Field>
          <Checkbox
            name="billable"
            value="true"
            defaultChecked
            label="Billable"
          />
          <input type="hidden" name="billable" value="false" />
          <div className="flex justify-end">
            <SubmitButton>Add</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(
    linkTicketAction.bind(null, ticketId),
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Link2 className="h-3.5 w-3.5" /> Link
      </Button>
      <DialogContent title="Link another ticket">
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <Field
            label="Ticket reference"
            htmlFor="ln-ref"
            required
            error={fieldErrors(result, "reference")}
          >
            <Input
              id="ln-ref"
              name="reference"
              placeholder="IT-000123"
              required
              autoFocus
            />
          </Field>
          <Field label="Relationship" htmlFor="ln-kind">
            <Select id="ln-kind" name="kind" defaultValue="related">
              <option value="related">Related</option>
              <option value="parent">This ticket is a child of it</option>
              <option value="duplicate">This ticket duplicates it</option>
            </Select>
          </Field>
          <div className="flex justify-end">
            <SubmitButton>Link</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
