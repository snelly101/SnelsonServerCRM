"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runRemindersAction } from "@/actions/contracts";

/** Manual trigger for the daily reminder job (renewals, reviews, expiries). */
export function RunRemindersButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
      <Button
        variant="secondary"
        loading={pending}
        title="Creates renewal and review tasks for contracts approaching their notice deadline. Runs automatically every day."
        onClick={() =>
          start(async () => {
            const res = await runRemindersAction();
            setMsg(res.ok ? `${res.data.created} reminder task${res.data.created === 1 ? "" : "s"} created` : res.error);
            router.refresh();
          })
        }
      >
        <BellRing className="h-4 w-4" /> Run reminders
      </Button>
    </span>
  );
}
