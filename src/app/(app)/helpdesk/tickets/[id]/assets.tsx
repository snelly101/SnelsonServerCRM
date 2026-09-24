"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MonitorSmartphone, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { linkDeviceAction, unlinkDeviceAction } from "@/actions/helpdesk-kb";
import { fmtRelative } from "@/lib/format";

export type LinkedDevice = {
  id: string;
  displayName: string | null;
  systemName: string | null;
  nodeClass: string;
  offline: boolean | null;
  lastContact: Date | null;
  osName: string | null;
  healthStatus: string | null;
  needsReboot: boolean | null;
  activeThreats: number | null;
  pendingOsPatches: number | null;
  externalStatus: string;
  companyId: string | null;
};

/** Devices from the NinjaOne mirror linked to this ticket, with their live flags. */
export function AssetsPanel({
  ticketId,
  devices,
  options,
  editable,
  hasCompany,
}: {
  ticketId: string;
  devices: LinkedDevice[];
  options: { id: string; displayName: string | null; systemName: string | null; nodeClass: string; offline: boolean | null }[];
  editable: boolean;
  hasCompany: boolean;
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
  const name = (d: { displayName: string | null; systemName: string | null }) => d.displayName ?? d.systemName ?? "device";
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-3 text-sm" aria-label="Devices">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Devices</h3>
        <Link href="/devices" className="text-xs text-brand-700 hover:underline">
          all devices
        </Link>
      </div>
      {error && <p className="mb-1 text-xs text-red-700">{error}</p>}
      <ul className="space-y-1.5 text-xs">
        {devices.map((d) => (
          <li key={d.id} className="flex items-start gap-1.5">
            <MonitorSmartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1">
                <Link href={`/devices?q=${encodeURIComponent(name(d))}`} className="font-medium text-slate-800 hover:text-brand-700">
                  {name(d)}
                </Link>
                <span className="text-slate-400">{d.nodeClass.replace(/_/g, " ").toLowerCase()}</span>
                {d.externalStatus === "deleted" ? (
                  <Badge tone="slate">removed from RMM</Badge>
                ) : d.offline ? (
                  <Badge tone="red">offline</Badge>
                ) : (
                  <Badge tone="green">online</Badge>
                )}
                {d.needsReboot && <Badge tone="amber">reboot</Badge>}
                {(d.activeThreats ?? 0) > 0 && <Badge tone="red">{d.activeThreats} threats</Badge>}
                {(d.pendingOsPatches ?? 0) > 0 && <Badge tone="amber">{d.pendingOsPatches} patches</Badge>}
              </div>
              <p className="text-slate-400">
                {d.osName ?? ""}
                {d.lastContact ? ` · seen ${fmtRelative(d.lastContact)}` : ""}
              </p>
            </div>
            {editable && (
              <button type="button" aria-label={`Unlink ${name(d)}`} className="text-slate-400 hover:text-red-700" onClick={() => run(() => unlinkDeviceAction(ticketId, d.id))}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {devices.length === 0 && <li className="text-slate-400">No devices linked.</li>}
      </ul>
      {editable && (
        <div className="mt-2">
          {options.length > 0 ? (
            <Select
              aria-label="Link a device"
              className="h-8 text-xs"
              value=""
              disabled={pending}
              onChange={(e) => {
                if (e.target.value) run(() => linkDeviceAction(ticketId, e.target.value, null));
              }}
            >
              <option value="">Link a device…</option>
              {options
                .filter((o) => !devices.some((d) => d.id === o.id))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {name(o)} ({o.nodeClass.replace(/_/g, " ").toLowerCase()}
                    {o.offline ? ", offline" : ""})
                  </option>
                ))}
            </Select>
          ) : (
            <p className="text-[11px] text-slate-400">
              {hasCompany ? "No RMM devices are mapped to this customer yet." : "Link the ticket to a company to pick its devices."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
