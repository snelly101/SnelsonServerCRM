"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { syncNowAction, testConnectionAction } from "@/actions/integrations";
import type { Provider } from "@/services/integrations";

export function TestButton({ provider }: { provider: Provider }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const res = await testConnectionAction(provider);
            setMsg(res.ok ? { ok: res.data.ok, text: res.data.message } : { ok: false, text: res.error });
            router.refresh();
          })
        }
      >
        <Stethoscope className="h-3.5 w-3.5" /> Test
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}

export function SyncNowButton({ provider, label = "Sync now" }: { provider: Provider; label?: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const res = await syncNowAction(provider);
            setMsg(res.ok ? res.data.message : res.error);
            router.refresh();
          })
        }
      >
        <RefreshCw className="h-3.5 w-3.5" /> {label}
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}
