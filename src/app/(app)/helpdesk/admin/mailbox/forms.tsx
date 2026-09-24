"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Stethoscope,
  Send,
  RefreshCw,
  RotateCcw,
  XCircle,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  cancelOutboxAction,
  connectMailboxAction,
  mailboxMaintenanceAction,
  replayInboundAction,
  retryOutboxAction,
  saveMailboxSettingsAction,
  sendTestEmailAction,
  testMailboxAction,
} from "@/actions/mailbox";
import { fmtRelative } from "@/lib/format";

export function ConnectMailboxForm({
  existing,
}: {
  existing: {
    address: string;
    displayName: string | null;
    tenantId: string | null;
    authMode: string;
    importFrom: Date | null;
  } | null;
}) {
  const [result, formAction] = useActionState(connectMailboxAction, null);
  const [authMode, setAuthMode] = useState<"secret" | "certificate">(
    (existing?.authMode as "secret" | "certificate") ?? "secret",
  );
  const e = (k: string) => fieldErrors(result, k);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Support mailbox address"
          htmlFor="mb-address"
          required
          error={e("address")}
        >
          <Input
            id="mb-address"
            name="address"
            type="email"
            required
            defaultValue={existing?.address ?? ""}
            placeholder="support@yourcompany.co.uk"
          />
        </Field>
        <Field label="Display name" htmlFor="mb-name">
          <Input
            id="mb-name"
            name="displayName"
            defaultValue={existing?.displayName ?? ""}
            placeholder="Support"
          />
        </Field>
        <Field
          label="Entra tenant id"
          htmlFor="mb-tenant"
          required
          error={e("tenantId")}
        >
          <Input
            id="mb-tenant"
            name="tenantId"
            required
            defaultValue={existing?.tenantId ?? ""}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </Field>
        <Field
          label="Application (client) id"
          htmlFor="mb-client"
          required
          error={e("clientId")}
        >
          <Input
            id="mb-client"
            name="clientId"
            required
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </Field>
        <Field label="Credential type" htmlFor="mb-mode">
          <Select
            id="mb-mode"
            name="authMode"
            value={authMode}
            onChange={(ev) =>
              setAuthMode(ev.target.value as "secret" | "certificate")
            }
          >
            <option value="secret">Client secret</option>
            <option value="certificate">Certificate (recommended)</option>
          </Select>
        </Field>
        <Field
          label="Credential expiry (for the warning banner)"
          htmlFor="mb-exp"
          help="Entra does not tell us when a secret or certificate expires; enter it from the app registration."
        >
          <Input id="mb-exp" name="credentialExpiresAt" type="date" />
        </Field>
        {authMode === "secret" ? (
          <Field
            label="Client secret value"
            htmlFor="mb-secret"
            required
            error={e("clientSecret")}
            className="sm:col-span-2"
          >
            <Input
              id="mb-secret"
              name="clientSecret"
              type="password"
              autoComplete="new-password"
            />
          </Field>
        ) : (
          <>
            <Field
              label="Private key (PEM)"
              htmlFor="mb-key"
              required
              error={e("clientSecret")}
            >
              <Textarea
                id="mb-key"
                name="privateKeyPem"
                rows={4}
                placeholder="-----BEGIN PRIVATE KEY-----"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Certificate (PEM)" htmlFor="mb-cert" required>
              <Textarea
                id="mb-cert"
                name="certificatePem"
                rows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                className="font-mono text-xs"
              />
            </Field>
          </>
        )}
        <Field
          label="Import mail received from"
          htmlFor="mb-from"
          help="Older mail is never turned into tickets. Leave empty for 'from now'."
        >
          <Input
            id="mb-from"
            name="importFrom"
            type="datetime-local"
            defaultValue={
              existing?.importFrom
                ? new Date(existing.importFrom).toISOString().slice(0, 16)
                : ""
            }
          />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        Stored encrypted on the server and never shown again. The connection is
        verified by reading one message from the inbox before anything is saved.
        See <code>docs/helpdesk-m365.md</code> for the app registration,
        permissions and mailbox scoping.
      </p>
      <SubmitButton size="sm">
        {existing?.tenantId
          ? "Replace credentials and reconnect"
          : "Verify and connect"}
      </SubmitButton>
    </form>
  );
}

export function MailboxButtons({ id, live }: { id: string; live: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  const run = (
    fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>,
    format: (d: unknown) => string,
  ) =>
    start(async () => {
      const r = await fn();
      setMsg(
        r.ok
          ? { ok: true, text: format(r.data) }
          : { ok: false, text: r.error ?? "Failed" },
      );
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {live && (
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            run(
              () => testMailboxAction(id),
              (d) => (d as { message: string }).message,
            )
          }
        >
          <Stethoscope className="h-3.5 w-3.5" /> Test connection
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          run(
            () => mailboxMaintenanceAction(id, "delta"),
            (d) => (d as { message: string }).message,
          )
        }
      >
        <RefreshCw className="h-3.5 w-3.5" /> Sync now
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          run(
            () => mailboxMaintenanceAction(id, "tick"),
            (d) => (d as { message: string }).message,
          )
        }
      >
        <Radio className="h-3.5 w-3.5" /> Process queues
      </Button>
      {live && (
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            run(
              () => mailboxMaintenanceAction(id, "subscription"),
              (d) => (d as { message: string }).message,
            )
          }
        >
          Renew subscription
        </Button>
      )}
      {msg && (
        <span
          className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}

export function TestEmailForm({
  id,
  staff,
}: {
  id: string;
  staff: { email: string; name: string }[];
}) {
  const [to, setTo] = useState(staff[0]?.email ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field
        label="Send a test e-mail to"
        htmlFor="mb-test-to"
        help="Only a CRM user's address is allowed."
      >
        <Select
          id="mb-test-to"
          value={to}
          onChange={(ev) => setTo(ev.target.value)}
          className="w-auto"
        >
          {staff.map((s) => (
            <option key={s.email} value={s.email}>
              {s.name} ({s.email})
            </option>
          ))}
        </Select>
      </Field>
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        disabled={!to}
        onClick={() =>
          start(async () => {
            const r = await sendTestEmailAction(id, to);
            setMsg(
              r.ok
                ? `Outbox status: ${r.data.status}${r.data.error ? ` (${r.data.error})` : ""}`
                : r.error,
            );
            router.refresh();
          })
        }
      >
        <Send className="h-3.5 w-3.5" /> Send test
      </Button>
      {msg && <span className="pb-2 text-xs text-slate-600">{msg}</span>}
    </div>
  );
}

export function MailboxSettingsForm({
  m,
}: {
  m: {
    id: string;
    displayName: string | null;
    folders: { id: string; name: string }[];
    importFrom: Date | null;
    ackEnabled: boolean;
    ackSubject: string;
    ackBody: string;
    unknownSenderPolicy: string;
    closedReplyPolicy: string;
    closedReopenDays: number;
    signature: string;
    credentialExpiresAt: Date | null;
  };
}) {
  const [result, formAction] = useActionState(
    saveMailboxSettingsAction.bind(null, m.id),
    null,
  );
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (result?.ok) setSaved(true);
  }, [result]);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      {saved && result?.ok && <p className="text-xs text-green-700">Saved.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" htmlFor="ms-name">
          <Input
            id="ms-name"
            name="displayName"
            defaultValue={m.displayName ?? ""}
          />
        </Field>
        <Field label="Import mail received from" htmlFor="ms-from">
          <Input
            id="ms-from"
            name="importFrom"
            type="datetime-local"
            defaultValue={
              m.importFrom
                ? new Date(m.importFrom).toISOString().slice(0, 16)
                : ""
            }
          />
        </Field>
        <Field
          label="Monitored folders"
          htmlFor="ms-folders"
          help="One per line as id|name. Only these folders create tickets; a mailbox rule that moves mail elsewhere hides it from the helpdesk."
          className="sm:col-span-2"
        >
          <Textarea
            id="ms-folders"
            name="folders"
            rows={2}
            defaultValue={m.folders.map((f) => `${f.id}|${f.name}`).join("\n")}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Unknown senders" htmlFor="ms-unknown">
          <Select
            id="ms-unknown"
            name="unknownSenderPolicy"
            defaultValue={m.unknownSenderPolicy}
          >
            <option value="create_unverified">
              Create the ticket with an unverified requester
            </option>
            <option value="review">
              Put the ticket in the review queue first
            </option>
          </Select>
        </Field>
        <Field label="Reply to a closed ticket" htmlFor="ms-closed">
          <Select
            id="ms-closed"
            name="closedReplyPolicy"
            defaultValue={m.closedReplyPolicy}
          >
            <option value="reopen">
              Reopen it within the window below, otherwise open a linked
              follow-up
            </option>
            <option value="follow_up">
              Always open a linked follow-up ticket
            </option>
          </Select>
        </Field>
        <Field label="Reopen window (days after closing)" htmlFor="ms-days">
          <Input
            id="ms-days"
            name="closedReopenDays"
            type="number"
            min={0}
            max={365}
            defaultValue={m.closedReopenDays}
            className="w-28"
          />
        </Field>
        <Field label="Credential expiry" htmlFor="ms-exp">
          <Input
            id="ms-exp"
            name="credentialExpiresAt"
            type="date"
            defaultValue={
              m.credentialExpiresAt
                ? new Date(m.credentialExpiresAt).toISOString().slice(0, 10)
                : ""
            }
          />
        </Field>
      </div>
      <Checkbox
        name="ackEnabled"
        value="true"
        defaultChecked={m.ackEnabled}
        label="Send an acknowledgement when a new ticket is created from e-mail (once per ticket, never to automated senders)"
      />
      <input type="hidden" name="ackEnabled" value="false" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Acknowledgement subject"
          htmlFor="ms-acksub"
          help="Placeholders: {{reference}}, {{subject}}, {{requester}}, {{signature}}"
          className="sm:col-span-2"
        >
          <Input id="ms-acksub" name="ackSubject" defaultValue={m.ackSubject} />
        </Field>
        <Field
          label="Acknowledgement body (Markdown)"
          htmlFor="ms-ackbody"
          className="sm:col-span-2"
        >
          <Textarea
            id="ms-ackbody"
            name="ackBody"
            rows={5}
            defaultValue={m.ackBody}
          />
        </Field>
        <Field
          label="Signature (Markdown, appended to agent replies)"
          htmlFor="ms-sig"
          className="sm:col-span-2"
        >
          <Textarea
            id="ms-sig"
            name="signature"
            rows={3}
            defaultValue={m.signature}
          />
        </Field>
      </div>
      <SubmitButton size="sm">Save settings</SubmitButton>
    </form>
  );
}

const TONE: Record<string, string> = {
  pending: "blue",
  processing: "amber",
  done: "green",
  skipped: "slate",
  failed: "red",
  dead: "red",
  queued: "blue",
  submitting: "amber",
  accepted: "green",
  unknown: "amber",
  cancelled: "slate",
};

export function QueueTable({
  rows,
  kind,
}: {
  rows: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    reference: string | null;
    ticketSubject: string | null;
    at: Date;
    detail: string | null;
    ticketId: string | null;
  }[];
  kind: "inbound" | "outbox";
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  if (rows.length === 0)
    return <p className="p-4 text-sm text-slate-500">Nothing here.</p>;
  return (
    <div>
      {msg && <p className="px-4 py-2 text-xs text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>When</th>
            <th>Status</th>
            <th>Ticket</th>
            <th>Detail</th>
            <th className="text-right">Attempts</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="whitespace-nowrap text-xs text-slate-500">
                {fmtRelative(r.at)}
              </td>
              <td>
                <Badge tone={TONE[r.status] ?? "slate"}>{r.status}</Badge>
              </td>
              <td className="text-xs">
                {r.ticketId ? (
                  <a
                    href={`/helpdesk/tickets/${r.ticketId}`}
                    className="text-brand-700 hover:underline"
                  >
                    {r.reference} {r.ticketSubject}
                  </a>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className="max-w-[360px] text-xs text-slate-600 [overflow-wrap:anywhere]">
                {r.lastError ? (
                  <span className="text-red-700">{r.lastError}</span>
                ) : (
                  r.detail
                )}
              </td>
              <td className="text-right text-xs tabular-nums">{r.attempts}</td>
              <td className="text-right">
                {kind === "inbound" &&
                  (r.status === "dead" ||
                    r.status === "failed" ||
                    r.status === "skipped") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => run(() => replayInboundAction(r.id))}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Replay
                    </Button>
                  )}
                {kind === "outbox" &&
                  (r.status === "failed" || r.status === "unknown") && (
                    <span className="inline-flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(() => retryOutboxAction(r.id))}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(() => cancelOutboxAction(r.id))}
                      >
                        <XCircle className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    </span>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
