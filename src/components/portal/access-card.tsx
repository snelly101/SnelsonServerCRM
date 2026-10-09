"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe, Link2, Send, ShieldCheck, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useToast } from "@/components/ui/toast";
import { invitePortalAction, setPortalAccessAction } from "@/actions/portal-admin";

export type PortalAccessState = { invitedAt: string; lastLoginAt: string | null; disabledAt: string | null; isCompanyAdmin: boolean; invitedByName: string | null } | null;

/**
 * Contact page card: give a contact access to the customer portal, make
 * them a company administrator (sees every ticket of their company), re-send
 * the sign-in link, or switch access off. The one-time link is shown after
 * sending so it can be passed on when no support mailbox is connected.
 */
export function PortalAccessCard({ contactId, hasEmail, state, canManage }: { contactId: string; hasEmail: boolean; state: PortalAccessState; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [admin, setAdmin] = useState(state?.isCompanyAdmin ?? false);
  const [link, setLink] = useState<{ url: string; emailed: boolean; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = () =>
    start(async () => {
      const r = await invitePortalAction(contactId, admin);
      if (!r.ok) return setError(r.error);
      setError(null);
      setLink({ url: r.data.link, emailed: r.data.emailed, expiresAt: r.data.expiresAt });
      toast(r.data.emailed ? "Sign-in link e-mailed." : "Link created; no support mailbox is connected, so pass it on yourself.", r.data.emailed ? "success" : "info");
      router.refresh();
    });
  const toggleAdmin = (next: boolean) => {
    setAdmin(next);
    if (!state) return;
    start(async () => {
      const r = await setPortalAccessAction(contactId, { isCompanyAdmin: next });
      if (!r.ok) return setError(r.error);
      toast(next ? "Now sees every request from their company." : "Now sees only their own requests.");
      router.refresh();
    });
  };

  const active = state && !state.disabledAt;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {!state ? <Badge>not invited</Badge> : active ? <Badge tone="green">active</Badge> : <Badge tone="red">switched off</Badge>}
        {state?.isCompanyAdmin && active && <Badge tone="indigo">company administrator</Badge>}
        {state && <span className="text-xs text-slate-500">invited {new Date(state.invitedAt).toLocaleDateString("en-GB")}{state.invitedByName ? ` by ${state.invitedByName}` : ""} · {state.lastLoginAt ? `last signed in ${new Date(state.lastLoginAt).toLocaleString("en-GB")}` : "never signed in"}</span>}
      </div>
      {!hasEmail && <p className="text-xs text-amber-700">Add an e-mail address to this contact first; the portal signs in by e-mailed link.</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>}
      {canManage && hasEmail && (
        <>
          <Checkbox label="Company administrator: can see and reply to every request from their company, not just their own" checked={admin} onChange={(e) => toggleAdmin(e.target.checked)} disabled={pending} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={state ? "secondary" : "primary"} onClick={invite} loading={pending}>
              {state ? <><Send className="h-4 w-4" /> Re-send sign-in link</> : <><Globe className="h-4 w-4" /> Give portal access</>}
            </Button>
            {state && (
              <ConfirmButton size="sm" variant={active ? "danger-outline" : "secondary"} action={setPortalAccessAction.bind(null, contactId, { enabled: !active })} title={active ? "Switch off portal access?" : "Switch portal access back on?"} description={active ? "Their current sessions end immediately. Tickets and history are kept." : undefined} confirmLabel={active ? "Switch off" : "Switch on"} successMessage={active ? "Portal access switched off" : "Portal access switched on"}>
                {active ? <><Ban className="h-4 w-4" /> Switch off</> : <><ShieldCheck className="h-4 w-4" /> Switch on</>}
              </ConfirmButton>
            )}
          </div>
        </>
      )}
      {link && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1 font-medium text-slate-700"><Link2 className="h-3.5 w-3.5" /> One-time sign-in link{link.emailed ? " (also e-mailed)" : " (not e-mailed: no support mailbox)"} · valid until {new Date(link.expiresAt).toLocaleString("en-GB")}</div>
          <code className="block select-all break-all rounded bg-surface px-2 py-1 text-[11px]">{link.url}</code>
          <p className="mt-1 text-slate-500">Send it to the contact directly if needed. It works once; after that they request fresh links from the portal sign-in page.</p>
        </div>
      )}
    </div>
  );
}
