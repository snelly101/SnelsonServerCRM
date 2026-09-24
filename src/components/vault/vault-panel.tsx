"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ClipboardCopy, Eye, EyeOff, ExternalLink, History, KeyRound, Pencil, Plus, Search, ShieldAlert, Star, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { archiveVaultItemAction, listItemHistoryAction, revealSecretAction, toggleFavouriteAction, totpCodeAction } from "@/actions/vault";
import { StepUpDialog } from "./step-up-dialog";
import { VaultItemDialog, type VaultItemMeta } from "./item-dialog";

export type VaultRow = VaultItemMeta & { categoryName: string; lastRevealedAt: Date | null; revealCount: number; archivedAt: Date | null; updatedAt: Date; updatedBy: string | null };
type Caps = { list: boolean; view_username: boolean; reveal: boolean; copy: boolean; create: boolean; edit: boolean; delete: boolean; audit: boolean };
type Revealed = { value: string; until: number };

const FIELD_LABEL: Record<string, string> = { password: "Password", notes: "Secure notes", api_key: "API key", recovery_codes: "Recovery codes", totp_secret: "Authenticator secret" };

export function VaultPanel({ companyId, items, caps, categories, sites, stepUpMinutes, configured, showArchived }: { companyId: string; items: VaultRow[]; caps: Caps; categories: { id: string; name: string }[]; sites: { id: string; name: string }[]; stepUpMinutes: number; configured: boolean; showArchived: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [tag, setTag] = useState("");
  const [editing, setEditing] = useState<VaultItemMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [stepUp, setStepUp] = useState<{ open: boolean; retry: (() => void) | null }>({ open: false, retry: null });
  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [totp, setTotp] = useState<Record<string, { code: string; secondsRemaining: number; period: number }>>({});
  const [history, setHistory] = useState<{ item: VaultRow; rows: { id: number; at: string; actorName: string | null; action: string; field: string | null; ipAddress: string | null }[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const timers = useRef<number[]>([]);

  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  const visible = items.filter((i) => (cat ? i.categoryId === cat : true) && (tag ? i.tags.includes(tag) : true) && (q ? [i.name, i.username ?? "", i.url ?? "", i.reference ?? "", i.categoryName, ...i.tags].join(" ").toLowerCase().includes(q.toLowerCase()) : true));

  // Re-mask everything when the tab is hidden and tick the countdowns.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") setRevealed({});
    };
    document.addEventListener("visibilitychange", hide);
    const tick = window.setInterval(() => {
      setRevealed((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.until > Date.now())));
      setTotp((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { ...v, secondsRemaining: v.secondsRemaining - 1 }])));
    }, 1000);
    const t = timers.current;
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.clearInterval(tick);
      t.forEach((x) => window.clearTimeout(x));
    };
  }, []);

  const withStepUp = useCallback((fn: () => void) => {
    setStepUp({ open: true, retry: fn });
  }, []);

  const reveal = (item: VaultRow, field: string) =>
    start(async () => {
      const key = `${item.id}:${field}`;
      if (revealed[key]) return setRevealed((r) => { const { [key]: _drop, ...rest } = r; void _drop; return rest; });
      const r = await revealSecretAction(item.id, field, "reveal");
      if (!r.ok) return setMsg(r.error);
      const data = r.data;
      if ("stepUpRequired" in data) return withStepUp(() => reveal(item, field));
      setRevealed((prev) => ({ ...prev, [key]: { value: data.value, until: Date.now() + data.hideAfterSeconds * 1000 } }));
      setMsg(null);
    });

  const copy = (item: VaultRow, field: string) =>
    start(async () => {
      const r = await revealSecretAction(item.id, field, "copy");
      if (!r.ok) return setMsg(r.error);
      const data = r.data;
      if ("stepUpRequired" in data) return withStepUp(() => copy(item, field));
      try {
        await navigator.clipboard.writeText(data.value);
      } catch {
        return setMsg("Your browser blocked clipboard access. Use Reveal instead.");
      }
      const clearAfter = data.clipboardClearSeconds;
      setCopied(`${FIELD_LABEL[field] ?? field} copied${clearAfter ? `, clipboard clears in ${clearAfter}s` : ""}`);
      timers.current.push(window.setTimeout(() => setCopied(null), 4000));
      if (clearAfter) timers.current.push(window.setTimeout(() => { if (document.hasFocus()) navigator.clipboard.writeText("").catch(() => undefined); }, clearAfter * 1000));
      setMsg(null);
    });

  const showTotp = (item: VaultRow) =>
    start(async () => {
      const r = await totpCodeAction(item.id);
      if (!r.ok) return setMsg(r.error);
      const data = r.data;
      if ("stepUpRequired" in data) return withStepUp(() => showTotp(item));
      setTotp((t) => ({ ...t, [item.id]: { code: data.code, secondsRemaining: data.secondsRemaining, period: data.period } }));
      setMsg(null);
    });

  const copyPlain = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label} copied`);
      timers.current.push(window.setTimeout(() => setCopied(null), 3000));
    } catch {
      setMsg("Your browser blocked clipboard access.");
    }
  };

  const openHistory = (item: VaultRow) =>
    start(async () => {
      const r = await listItemHistoryAction(item.id, companyId);
      if (!r.ok) return setMsg(r.error);
      setHistory({ item, rows: r.data.rows });
    });

  const fields = (item: VaultRow) => {
    const out: { key: string; label: string; multiline?: boolean }[] = [];
    for (const k of item.secretKinds) {
      if (k === "password") out.push({ key: "password", label: "Password" });
      else if (k === "notes") out.push({ key: "notes", label: "Secure notes", multiline: true });
      else if (k === "api_key") out.push({ key: "api_key", label: "API key" });
      else if (k === "recovery_codes") out.push({ key: "recovery_codes", label: "Recovery codes", multiline: true });
      else if (k.startsWith("custom:")) for (let i = 0; i < Number(k.slice(7)); i++) out.push({ key: `custom:${i}`, label: `Custom field ${i + 1}` });
    }
    return out;
  };

  const today = new Date().toISOString().slice(0, 10);
  const dateBadge = (item: VaultRow) => {
    if (item.expiresAt && item.expiresAt < today) return <Badge tone="red">expired {item.expiresAt}</Badge>;
    if (item.expiresAt) return <Badge tone="amber">expires {item.expiresAt}</Badge>;
    if (item.reviewAt && item.reviewAt <= today) return <Badge tone="amber">review due</Badge>;
    return null;
  };

  return (
    <div className="space-y-3">
      {!configured && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"><ShieldAlert className="mr-1 inline h-4 w-4" />The vault master key is not configured on this server, so items can be listed but not created or revealed.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <Input aria-label="Search vault" placeholder="Search name, username, URL…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="w-auto">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        {tags.length > 0 && (
          <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="w-auto">
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        )}
        <a href={showArchived ? `/companies/${companyId}?tab=vault` : `/companies/${companyId}?tab=vault&archived=1`} className="text-xs text-slate-500 hover:underline">{showArchived ? "Hide archived" : "Show archived"}</a>
        {caps.create && configured && (
          <Button className="ml-auto" size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add item</Button>
        )}
      </div>
      {msg && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{msg}</p>}
      {copied && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800" role="status">{copied}</p>}

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{items.length === 0 ? "No credentials stored for this customer yet." : "Nothing matches the filter."}</p>
      ) : (
        <ul className={`divide-y divide-slate-100 rounded-md border border-slate-200 bg-surface ${pending ? "opacity-80" : ""}`}>
          {visible.map((item) => (
            <li key={item.id} className={`p-3 ${item.archivedAt ? "bg-slate-50 opacity-70" : ""}`}>
              <div className="flex flex-wrap items-start gap-3">
                <button type="button" className={`mt-0.5 ${item.isFavourite ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`} aria-label={item.isFavourite ? "Unfavourite" : "Favourite"} onClick={() => start(async () => { await toggleFavouriteAction(item.id, companyId); router.refresh(); })}>
                  <Star className="h-4 w-4" fill={item.isFavourite ? "currentColor" : "none"} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{item.name}</span>
                    <Badge tone="slate">{item.categoryName}</Badge>
                    {item.tags.map((t) => (
                      <Badge key={t} tone="blue">{t}</Badge>
                    ))}
                    {dateBadge(item)}
                    {item.archivedAt && <Badge tone="red">archived</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                    {item.username && (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-slate-400">user</span> <span className="font-mono">{item.username}</span>
                        {caps.view_username && <button type="button" className="text-slate-400 hover:text-brand-700" aria-label="Copy username" onClick={() => copyPlain(item.username!, "Username")}><ClipboardCopy className="h-3 w-3" /></button>}
                      </span>
                    )}
                    {item.url && (
                      <a href={item.url.startsWith("http") ? item.url : `https://${item.url}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-700 hover:underline">{item.url.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" /></a>
                    )}
                    {item.reference && <span><span className="text-slate-400">ref</span> {item.reference}</span>}
                    <span className="text-slate-400">updated {new Date(item.updatedAt).toLocaleDateString("en-GB")}{item.updatedBy ? ` by ${item.updatedBy}` : ""}{item.revealCount ? ` · revealed ${item.revealCount}×` : ""}</span>
                  </div>

                  {!item.archivedAt && (fields(item).length > 0 || item.secretKinds.includes("totp")) && (
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {fields(item).map((f) => {
                        const key = `${item.id}:${f.key}`;
                        const r = revealed[key];
                        return (
                          <div key={f.key} className="flex items-center gap-1.5 rounded border border-slate-100 bg-slate-50 px-2 py-1 text-xs">
                            <span className="w-28 shrink-0 text-slate-500">{f.label}</span>
                            <span className={`min-w-0 flex-1 font-mono ${f.multiline ? "whitespace-pre-wrap break-all" : "truncate"}`}>{r ? r.value : "••••••••••••"}</span>
                            {r && <span className="inline-flex items-center gap-0.5 text-slate-400"><Timer className="h-3 w-3" />{Math.max(0, Math.ceil((r.until - Date.now()) / 1000))}s</span>}
                            {caps.reveal && configured && (
                              <button type="button" className="text-slate-500 hover:text-brand-700" aria-label={r ? `Hide ${f.label}` : `Reveal ${f.label}`} onClick={() => reveal(item, f.key)}>{r ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
                            )}
                            {caps.copy && configured && (
                              <button type="button" className="text-slate-500 hover:text-brand-700" aria-label={`Copy ${f.label}`} onClick={() => copy(item, f.key)}><ClipboardCopy className="h-3.5 w-3.5" /></button>
                            )}
                          </div>
                        );
                      })}
                      {item.secretKinds.includes("totp") && (
                        <div className="flex items-center gap-1.5 rounded border border-slate-100 bg-slate-50 px-2 py-1 text-xs">
                          <span className="w-28 shrink-0 text-slate-500">Authenticator</span>
                          <span className="flex-1 font-mono text-base tracking-widest">{totp[item.id] && totp[item.id].secondsRemaining > 0 ? totp[item.id].code : "••• •••"}</span>
                          {totp[item.id] && totp[item.id].secondsRemaining > 0 && <span className="inline-flex items-center gap-0.5 text-slate-400"><Timer className="h-3 w-3" />{totp[item.id].secondsRemaining}s</span>}
                          {caps.reveal && configured && (
                            <button type="button" className="text-slate-500 hover:text-brand-700" aria-label="Show authenticator code" onClick={() => showTotp(item)}><KeyRound className="h-3.5 w-3.5" /></button>
                          )}
                          {caps.copy && configured && totp[item.id] && totp[item.id].secondsRemaining > 0 && (
                            <button type="button" className="text-slate-500 hover:text-brand-700" aria-label="Copy authenticator code" onClick={() => copyPlain(totp[item.id].code, "Code")}><ClipboardCopy className="h-3.5 w-3.5" /></button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {caps.audit && <Button size="sm" variant="ghost" aria-label="History" title="Who did what with this item" onClick={() => openHistory(item)}><History className="h-3.5 w-3.5" /></Button>}
                  {caps.edit && configured && !item.archivedAt && <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(item)}><Pencil className="h-3.5 w-3.5" /></Button>}
                  {caps.delete && (
                    <Button size="sm" variant="ghost" aria-label={item.archivedAt ? "Restore" : "Archive"} title={item.archivedAt ? "Restore" : "Archive (kept, can be restored)"} onClick={() => start(async () => { const r = await archiveVaultItemAction(item.id, companyId, Boolean(item.archivedAt)); if (!r.ok) setMsg(r.error); router.refresh(); })}>
                      {item.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <StepUpDialog open={stepUp.open} windowMinutes={stepUpMinutes} onOpenChange={(o) => setStepUp((s) => ({ ...s, open: o }))} onVerified={() => { const fn = stepUp.retry; setStepUp({ open: false, retry: null }); fn?.(); }} />
      {(creating || editing) && <VaultItemDialog open onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} companyId={companyId} item={editing} categories={categories} sites={sites} />}
      <Dialog open={Boolean(history)} onOpenChange={(o) => !o && setHistory(null)}>
        {history && (
          <DialogContent title={`History: ${history.item.name}`} description="Every reveal, copy and change, newest first. Secrets are never recorded." wide>
            {history.rows.length === 0 ? (
              <p className="text-sm text-slate-500">No events.</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Field</th><th>From</th></tr></thead>
                <tbody>
                  {history.rows.map((r) => (
                    <tr key={r.id}><td className="whitespace-nowrap text-slate-500">{new Date(r.at).toLocaleString("en-GB")}</td><td>{r.actorName ?? "system"}</td><td><Badge tone={r.action === "revealed" || r.action === "copied" || r.action === "totp_code" ? "amber" : r.action === "archived" ? "red" : "slate"}>{r.action.replace(/_/g, " ")}</Badge></td><td className="font-mono text-xs">{r.field ?? ""}</td><td className="font-mono text-xs text-slate-500">{r.ipAddress ?? ""}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
