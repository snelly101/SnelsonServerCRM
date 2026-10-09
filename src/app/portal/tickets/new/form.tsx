"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";

export function NewRequestForm() {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("subject", subject);
      fd.set("description", description);
      fd.set("priority", priority);
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/portal/tickets", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string; refused?: { fileName: string; error: string }[] };
      if (!res.ok || !j.id) return setError(j.error ?? "Could not create the request. Try again.");
      router.push(`/portal/tickets/${j.id}${j.refused?.length ? `?refused=${encodeURIComponent(j.refused.map((r) => `${r.fileName}: ${r.error}`).join("; "))}` : ""}`);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4 rounded-lg border border-slate-200 bg-surface p-4" onSubmit={submit}>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Subject" htmlFor="nr-subject" help="A short summary, e.g. “Printer on 2nd floor offline”">
        <Input id="nr-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} required />
      </Field>
      <Field label="What is happening?" htmlFor="nr-desc" help="What you were doing, what you expected, any error messages, who is affected">
        <Textarea id="nr-desc" rows={8} value={description} onChange={(e) => setDescription(e.target.value)} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How urgent is it?" htmlFor="nr-priority">
          <Select id="nr-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low: whenever convenient</option>
            <option value="normal">Normal: affects my work</option>
            <option value="high">High: several people cannot work</option>
          </Select>
        </Field>
        <Field label="Attachments" htmlFor="nr-files" help="Screenshots or documents, up to 25 MB each">
          <input id="nr-files" type="file" multiple className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-surface file:px-3 file:py-1.5 file:text-sm" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          {files.length > 0 && <p className="mt-1 text-xs text-slate-500"><Paperclip className="mr-1 inline h-3 w-3" />{files.map((f) => f.name).join(", ")}</p>}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={busy}><Send className="h-4 w-4" /> Send request</Button>
      </div>
    </form>
  );
}
