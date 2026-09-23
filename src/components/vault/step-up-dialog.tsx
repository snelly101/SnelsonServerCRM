"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { verifyStepUpAction } from "@/actions/vault";

/** Asks for the user's CRM password before secrets can be revealed. Opens a server-side window; nothing is stored in the browser. */
export function StepUpDialog({ open, onOpenChange, onVerified, windowMinutes }: { open: boolean; onOpenChange: (o: boolean) => void; onVerified: () => void; windowMinutes: number }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setPassword(""); setError(null); } }}>
      <DialogContent title="Confirm it's you" description={`Enter your CRM password to reveal or copy secrets for the next ${windowMinutes} minutes. Every reveal is recorded.`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await verifyStepUpAction(password);
              setPassword("");
              if (!r.ok) return setError(r.error);
              setError(null);
              onOpenChange(false);
              onVerified();
            });
          }}
        >
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
          <Field label="Password" htmlFor="stepup-pw">
            <Input id="stepup-pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={pending}><ShieldCheck className="h-4 w-4" /> Confirm</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
