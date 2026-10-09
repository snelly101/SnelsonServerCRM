"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";

export function ReplyForm({ ticketId, reopens }: { ticketId: string; reopens: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("body", body);
      for (const f of files) fd.append("files", f);
      const res = await fetch(`/api/portal/tickets/${ticketId}/reply`, { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; refused?: { fileName: string; error: string }[] };
      if (!res.ok) return setError(j.error ?? "Could not send your reply.");
      setBody("");
      setFiles([]);
      setNotice(j.refused?.length ? `Reply sent. Not accepted: ${j.refused.map((r) => `${r.fileName} (${r.error})`).join(", ")}` : "Reply sent.");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-3 rounded-lg border border-slate-200 bg-surface p-4" onSubmit={submit}>
      <h2 className="text-sm font-semibold text-slate-800">{reopens ? "Reply to reopen this request" : "Reply"}</h2>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <Field label="Your message" htmlFor="reply-body">
        <Textarea id="reply-body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} required />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs text-slate-600">
          <input type="file" multiple className="block text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-surface file:px-3 file:py-1.5 file:text-sm" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          {files.length > 0 && <span className="mt-1 block"><Paperclip className="mr-1 inline h-3 w-3" />{files.map((f) => f.name).join(", ")}</span>}
        </label>
        <Button type="submit" loading={busy}><Send className="h-4 w-4" /> Send</Button>
      </div>
    </form>
  );
}
