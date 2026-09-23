"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, ShieldCheck, Trash2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Checkbox, SubmitButton, FormMessage } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { archiveCategoryAction, createCategoryAction, revokeGrantAction, rewrapAllItemsAction, saveGrantAction, saveVaultSettingsAction, verifyAuditChainAction } from "@/actions/vault";

const CAPS: { key: "canList" | "canViewUsername" | "canReveal" | "canCopy" | "canCreate" | "canEdit" | "canDelete" | "canAudit"; label: string }[] = [
  { key: "canList", label: "See items" },
  { key: "canViewUsername", label: "View usernames" },
  { key: "canReveal", label: "Reveal secrets" },
  { key: "canCopy", label: "Copy secrets" },
  { key: "canCreate", label: "Create" },
  { key: "canEdit", label: "Edit" },
  { key: "canDelete", label: "Archive / restore" },
  { key: "canAudit", label: "View history" },
];

export type GrantRow = { id: string; userId: string; userName: string; userEmail: string; userRole: string; scope: "all" | "company"; companyId: string | null; companyName: string | null; canList: boolean; canViewUsername: boolean; canReveal: boolean; canCopy: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean; canAudit: boolean; expiresAt: Date | null };

export function GrantsTable({ grants, users, companies }: { grants: GrantRow[]; users: { id: string; name: string; role: string }[]; companies: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const empty = { userId: users[0]?.id ?? "", scope: "all" as "all" | "company", companyId: "", canList: true, canViewUsername: true, canReveal: true, canCopy: true, canCreate: true, canEdit: true, canDelete: false, canAudit: false, expiresAt: "" };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      const r = await saveGrantAction({ ...form, companyId: form.scope === "company" ? form.companyId : null, expiresAt: form.expiresAt || null }, editingId);
      if (!r.ok) return setError(r.error);
      setError(null);
      setForm(empty);
      setEditingId(null);
      router.refresh();
    });
  return (
    <div>
      {grants.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">No grants yet. Administrators always have full access; technicians need a grant below.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th>Scope</th>
              <th>Capabilities</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>
                  <div className="font-medium">{g.userName}</div>
                  <div className="text-xs text-slate-500">{g.userEmail} · {g.userRole.replace("_", " ")}</div>
                </td>
                <td>{g.scope === "all" ? <Badge tone="blue">all customers</Badge> : <Badge tone="slate">{g.companyName ?? "one customer"}</Badge>}</td>
                <td className="text-xs">{CAPS.filter((c) => g[c.key]).map((c) => c.label).join(", ") || "none"}</td>
                <td className="text-xs text-slate-500">{g.expiresAt ? new Date(g.expiresAt).toLocaleDateString("en-GB") : "never"}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setEditingId(g.id); setForm({ userId: g.userId, scope: g.scope, companyId: g.companyId ?? "", canList: g.canList, canViewUsername: g.canViewUsername, canReveal: g.canReveal, canCopy: g.canCopy, canCreate: g.canCreate, canEdit: g.canEdit, canDelete: g.canDelete, canAudit: g.canAudit, expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString().slice(0, 10) : "" }); }}>Edit</Button>
                  <ConfirmButton size="sm" variant="ghost" action={revokeGrantAction.bind(null, g.id)} title={`Revoke ${g.userName}'s vault access?`} confirmLabel="Revoke"><Trash2 className="h-3.5 w-3.5" /></ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="space-y-3 border-t border-slate-100 p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="text-sm font-medium text-slate-700">{editingId ? "Edit grant" : "Add a grant"}</p>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="User" htmlFor="g-user" help="Technicians only; other roles cannot hold vault access">
            <Select id="g-user" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} disabled={Boolean(editingId)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.role.replace("_", " ")})</option>
              ))}
            </Select>
          </Field>
          <Field label="Scope" htmlFor="g-scope">
            <Select id="g-scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as "all" | "company" })}>
              <option value="all">All customers</option>
              <option value="company">One customer</option>
            </Select>
          </Field>
          {form.scope === "company" && (
            <Field label="Customer" htmlFor="g-company">
              <Select id="g-company" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
                <option value="">— choose —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Expires" htmlFor="g-exp" help="Optional">
            <Input id="g-exp" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {CAPS.map((c) => (
            <Checkbox key={c.key} label={c.label} checked={form[c.key]} onChange={(e) => setForm({ ...form, [c.key]: e.target.checked })} />
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" loading={pending}><Plus className="h-4 w-4" /> {editingId ? "Save grant" : "Add grant"}</Button>
          {editingId && <Button type="button" size="sm" variant="secondary" onClick={() => { setEditingId(null); setForm(empty); }}>Cancel</Button>}
        </div>
      </form>
    </div>
  );
}

export function CategoryForm() {
  const [result, formAction] = useActionState(createCategoryAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <FormMessage result={result} />
      <Field label="New category" htmlFor="c-name"><Input id="c-name" name="name" required maxLength={60} placeholder="e.g. Printer" /></Field>
      <SubmitButton size="sm"><Plus className="h-4 w-4" /> Add</SubmitButton>
    </form>
  );
}

export function CategoryList({ categories }: { categories: { id: string; name: string; isSystem: boolean; archivedAt: Date | null; itemCount: number }[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {categories.map((c) => (
        <li key={c.id} className="flex items-center justify-between px-4 py-2 text-sm">
          <span className={c.archivedAt ? "text-slate-400 line-through" : ""}>{c.name} <span className="text-xs text-slate-400">· {c.itemCount} item{c.itemCount === 1 ? "" : "s"}{c.isSystem ? " · built-in" : ""}</span></span>
          {!c.isSystem && (
            <ConfirmButton size="sm" variant="ghost" action={archiveCategoryAction.bind(null, c.id, Boolean(c.archivedAt))} title={c.archivedAt ? "Restore this category?" : "Archive this category?"} description="Existing items keep it; it is just hidden from the picker." confirmLabel={c.archivedAt ? "Restore" : "Archive"}>
              {c.archivedAt ? "Restore" : "Archive"}
            </ConfirmButton>
          )}
        </li>
      ))}
    </ul>
  );
}

export function VaultSettingsForm({ settings }: { settings: { vaultRevealSeconds: number; vaultClipboardSeconds: number; vaultStepUpMinutes: number; vaultReviewReminderDays: number; vaultRevealLimit: number } }) {
  const [result, formAction] = useActionState(saveVaultSettingsAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Hide revealed secrets after (seconds)" htmlFor="s-reveal"><Input id="s-reveal" name="vaultRevealSeconds" type="number" min={5} max={600} defaultValue={settings.vaultRevealSeconds} /></Field>
        <Field label="Clear clipboard after (seconds, 0 = never)" htmlFor="s-clip" help="Best effort: browsers only allow this while the tab is focused"><Input id="s-clip" name="vaultClipboardSeconds" type="number" min={0} max={600} defaultValue={settings.vaultClipboardSeconds} /></Field>
        <Field label="Password re-confirmation window (minutes)" htmlFor="s-step"><Input id="s-step" name="vaultStepUpMinutes" type="number" min={1} max={720} defaultValue={settings.vaultStepUpMinutes} /></Field>
        <Field label="Review / expiry reminder (days before)" htmlFor="s-rem"><Input id="s-rem" name="vaultReviewReminderDays" type="number" min={1} max={180} defaultValue={settings.vaultReviewReminderDays} /></Field>
        <Field label="Reveal limit per user per 10 minutes" htmlFor="s-limit" help="Exceeding it blocks reveals and raises an urgent task for an administrator"><Input id="s-limit" name="vaultRevealLimit" type="number" min={1} max={10000} defaultValue={settings.vaultRevealLimit} /></Field>
      </div>
      <SubmitButton size="sm">Save</SubmitButton>
    </form>
  );
}

export function MaintenanceButtons() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await verifyAuditChainAction(); setMsg(r.ok ? (r.data.ok ? `Chain intact: ${r.data.checked} entries verified.` : `INTEGRITY FAILURE at entry ${r.data.brokenAt}. Treat the audit trail as tampered from that point.`) : r.error); router.refresh(); })}>
        <ShieldCheck className="h-4 w-4" /> Verify audit chain
      </Button>
      <ConfirmButton size="sm" variant="secondary" action={rewrapAllItemsAction} title="Re-wrap every item with the current master key?" description="Use after rotating VAULT_MASTER_KEY (with the old key in VAULT_MASTER_KEY_PREVIOUS). Items already on the current key are skipped." confirmLabel="Re-wrap">
        <KeyRound className="h-4 w-4" /> Re-wrap with current key
      </ConfirmButton>
      <Button size="sm" variant="ghost" onClick={() => router.refresh()}><RefreshCw className="h-4 w-4" /></Button>
      {msg && <span className={`text-xs ${msg.includes("FAILURE") ? "font-medium text-red-700" : "text-slate-600"}`}>{msg}</span>}
    </div>
  );
}
