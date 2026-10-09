"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Download, ExternalLink, FileText, Image as ImageIcon, Pencil, Trash2, Upload, ArchiveRestore, File as FileIcon, FileSpreadsheet, FileArchive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/page";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useToast } from "@/components/ui/toast";
import { deleteAttachmentAction, updateAttachmentAction } from "@/actions/attachments";

export type AttachmentItem = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  tags: string[];
  isImage: boolean;
  hasThumbnail: boolean;
  scanStatus: string;
  siteId: string | null;
  siteName: string | null;
  uploadedByName: string | null;
  createdAt: string;
  createdAtRelative: string;
  deletedAt: string | null;
  deletedByName: string | null;
};

export type SiteOption = { id: string; name: string };

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function kindOf(a: AttachmentItem): "photo" | "document" {
  return a.isImage ? "photo" : "document";
}

function DocIcon({ contentType, fileName, className }: { contentType: string; fileName: string; className?: string }) {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (/pdf|msword|wordprocessingml|text\//.test(contentType) || /^(pdf|docx?|txt|md|rtf)$/.test(ext)) return <FileText className={className} aria-hidden />;
  if (/spreadsheet|excel|csv/.test(contentType) || /^(xlsx?|csv)$/.test(ext)) return <FileSpreadsheet className={className} aria-hidden />;
  if (/zip|compressed|tar|7z/.test(contentType) || /^(zip|7z|gz|tgz|rar)$/.test(ext)) return <FileArchive className={className} aria-hidden />;
  return <FileIcon className={className} aria-hidden />;
}

/**
 * The company's Files tab: photos and documents on the data volume. Upload
 * from disk, the phone camera, or by dropping files on the panel; photos
 * show as thumbnails, documents as cards; click for the viewer with caption,
 * site, rename, download and remove. Removed files stay restorable until
 * the nightly purge.
 */
export function AttachmentsPanel({ companyId, items, sites, canWrite, showDeleted, usage }: { companyId: string; items: AttachmentItem[]; sites: SiteOption[]; canWrite: boolean; showDeleted: boolean; usage: { bytes: number; quotaBytes: number } }) {
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<"all" | "photo" | "document">("all");
  const [siteFilter, setSiteFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AttachmentItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      setUploading(`Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`);
      try {
        const fd = new FormData();
        fd.set("companyId", companyId);
        if (siteFilter) fd.set("siteId", siteFilter);
        for (const f of list) fd.append("files", f);
        const res = await fetch("/api/attachments/upload", { method: "POST", body: fd });
        const j = (await res.json().catch(() => ({}))) as { stored?: { fileName: string }[]; refused?: { fileName: string; error: string }[]; error?: string };
        if (!res.ok) {
          toast(j.error ?? `Upload failed (${res.status}).`, "error");
          return;
        }
        if (j.stored?.length) toast(`Added ${j.stored.length} file${j.stored.length === 1 ? "" : "s"}.`, "success");
        for (const r of j.refused ?? []) toast(`${r.fileName}: ${r.error}`, "error");
        router.refresh();
      } catch {
        toast("Upload did not complete.", "error");
      } finally {
        setUploading(null);
        if (fileInput.current) fileInput.current.value = "";
        if (cameraInput.current) cameraInput.current.value = "";
      }
    },
    [companyId, siteFilter, router, toast],
  );

  const live = items.filter((a) => !a.deletedAt);
  const shown = (showDeleted ? items : live).filter((a) => (filter === "all" || kindOf(a) === filter) && (!siteFilter || a.siteId === siteFilter) && (!q || `${a.fileName} ${a.caption ?? ""} ${a.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const deletedCount = items.filter((a) => a.deletedAt).length;
  const base = `/companies/${companyId}?tab=files`;

  return (
    <section
      aria-labelledby="files-heading"
      className={`space-y-3 rounded-lg ${dragging ? "outline outline-2 outline-dashed outline-brand-400" : ""}`}
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="files-heading" className="text-sm font-semibold text-slate-800">
          Files <span className="font-normal text-slate-500">· {live.length} · {fmtBytes(usage.bytes)} of {fmtBytes(usage.quotaBytes)}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <a href={showDeleted ? base : `${base}&deleted=1`} className="text-xs text-slate-500 hover:underline">
            {showDeleted ? "Hide removed" : `Show removed${deletedCount ? ` (${deletedCount})` : ""}`}
          </a>
          {canWrite && (
            <>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
              <Button size="sm" variant="secondary" onClick={() => cameraInput.current?.click()} loading={Boolean(uploading)}>
                <Camera className="h-4 w-4" /> Take photo
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()} loading={Boolean(uploading)}>
                <Upload className="h-4 w-4" /> Upload
              </Button>
            </>
          )}
        </div>
      </div>
      {uploading && <p className="text-xs text-slate-500" role="status">{uploading} Photos are resized and stripped of location data.</p>}

      {live.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex rounded-md border border-slate-200 bg-surface p-0.5">
            {(["all", "photo", "document"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded px-2 py-1 ${filter === k ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                {k === "all" ? "All" : k === "photo" ? "Photos" : "Documents"}
              </button>
            ))}
          </div>
          {sites.length > 0 && (
            <Select aria-label="Site" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className="h-7 w-auto py-0.5 text-xs leading-tight">
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
          <Input aria-label="Search files" placeholder="Search name, caption, tag" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-56 py-0.5 text-xs" />
        </div>
      )}

      {live.length === 0 && !showDeleted ? (
        <EmptyState
          icon={<ImageIcon className="h-6 w-6" aria-hidden />}
          title="No files yet"
          description={canWrite ? "Photograph the comms cabinet, attach floor plans, contracts and network diagrams. Drop files here or use Upload. On a phone, Take photo opens the camera." : "Nothing has been attached to this company."}
          action={canWrite ? <Button size="sm" onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" /> Upload</Button> : undefined}
        />
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing matches.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((a) => (
            <li key={a.id} className={`group overflow-hidden rounded-md border bg-surface ${a.deletedAt ? "border-dashed border-slate-300 opacity-70" : "border-slate-200"}`}>
              <button type="button" onClick={() => setOpen(a)} className="block w-full text-left" aria-label={`Open ${a.fileName}`}>
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-100">
                  {a.isImage && a.hasThumbnail && a.scanStatus !== "blocked" && a.scanStatus !== "pending" && a.scanStatus !== "error" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/attachments/${a.id}?v=thumb`} alt={a.caption ?? a.fileName} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                  ) : (
                    <DocIcon contentType={a.contentType} fileName={a.fileName} className="h-10 w-10 text-slate-400" />
                  )}
                </div>
                <div className="space-y-0.5 px-2.5 py-2">
                  <div className="truncate text-[13px] font-medium text-slate-800" title={a.fileName}>{a.caption || a.fileName}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    {fmtBytes(a.sizeBytes)} · {a.createdAtRelative}{a.uploadedByName ? ` · ${a.uploadedByName}` : ""}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {a.siteName && <Badge tone="blue">{a.siteName}</Badge>}
                    {a.deletedAt && <Badge tone="amber">removed</Badge>}
                    {a.scanStatus === "blocked" && <Badge tone="red">blocked</Badge>}
                    {(a.scanStatus === "pending" || a.scanStatus === "error") && <Badge tone="amber">unscanned</Badge>}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <AttachmentDialog item={open} sites={sites} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AttachmentDialog({ item, sites, canWrite, onClose }: { item: AttachmentItem; sites: SiteOption[]; canWrite: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(item.caption ?? "");
  const [fileName, setFileName] = useState(item.fileName);
  const [siteId, setSiteId] = useState(item.siteId ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const viewable = item.scanStatus !== "blocked" && item.scanStatus !== "pending" && item.scanStatus !== "error";
  const inlineOk = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/i.test(item.contentType);

  const save = () =>
    start(async () => {
      const r = await updateAttachmentAction(item.id, { caption, fileName, siteId: siteId || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
      if (!r.ok) return setError(r.error);
      setError(null);
      setEditing(false);
      toast("Saved.", "success");
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={item.caption || item.fileName} description={`${fmtBytes(item.sizeBytes)}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ""} · added ${item.createdAtRelative}${item.uploadedByName ? ` by ${item.uploadedByName}` : ""}${item.deletedAt ? ` · removed${item.deletedByName ? ` by ${item.deletedByName}` : ""}` : ""}`} wide>
        <div className="space-y-3">
          {item.isImage && viewable ? (
            <div className="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-md bg-slate-900/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/attachments/${item.id}?v=inline`} alt={item.caption ?? item.fileName} className="max-h-[60vh] w-auto max-w-full object-contain" />
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-6">
              <DocIcon contentType={item.contentType} fileName={item.fileName} className="h-10 w-10 text-slate-400" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-800">{item.fileName}</div>
                <div className="text-xs text-slate-500">{item.contentType}{!viewable ? ` · ${item.scanStatus === "blocked" ? "blocked by the virus scanner" : "not yet scanned"}` : ""}</div>
              </div>
            </div>
          )}
          {!editing && (
            <div className="text-sm text-slate-700">
              {item.caption && item.caption !== item.fileName && <p className="text-xs text-slate-500">{item.fileName}</p>}
              <div className="mt-1 flex flex-wrap gap-1">
                {item.siteName && <Badge tone="blue">{item.siteName}</Badge>}
                {item.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            </div>
          )}
          {editing && (
            <div className="space-y-3">
              {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="File name" htmlFor="at-name"><Input id="at-name" value={fileName} onChange={(e) => setFileName(e.target.value)} maxLength={200} /></Field>
                <Field label="Site" htmlFor="at-site">
                  <Select id="at-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    <option value="">— none —</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Caption" htmlFor="at-caption" help="Shown instead of the file name on the grid"><Textarea id="at-caption" rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={500} /></Field>
              <Field label="Tags" htmlFor="at-tags" help="Comma separated, e.g. cabinet, floor plan"><Input id="at-tags" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              {viewable && (
                <a href={`/api/attachments/${item.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-surface px-2.5 text-xs font-medium text-slate-800 hover:bg-slate-50" download>
                  <Download className="h-3.5 w-3.5" /> Download
                </a>
              )}
              {viewable && inlineOk && (
                <a href={`/api/attachments/${item.id}?v=inline`} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-surface px-2.5 text-xs font-medium text-slate-800 hover:bg-slate-50">
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              )}
            </div>
            {canWrite && (
              <div className="flex gap-2">
                {editing ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
                    <Button size="sm" onClick={save} loading={pending}>Save</Button>
                  </>
                ) : (
                  <>
                    {!item.deletedAt && (
                      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                    )}
                    {item.deletedAt ? (
                      <ConfirmButton size="sm" variant="secondary" action={deleteAttachmentAction.bind(null, item.id, true)} title="Restore this file?" confirmLabel="Restore" successMessage="File restored">
                        <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                      </ConfirmButton>
                    ) : (
                      <ConfirmButton size="sm" variant="danger-outline" action={deleteAttachmentAction.bind(null, item.id, false)} title={`Remove ${item.fileName}?`} description="It is hidden straight away and can be restored from “Show removed” for 30 days; after that the file is deleted for good." confirmLabel="Remove" successMessage="File removed">
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </ConfirmButton>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
