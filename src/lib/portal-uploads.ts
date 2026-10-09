import { MAX_ATTACHMENT_BYTES } from "@/lib/email/storage";
import type { PortalUpload } from "@/services/portal";

/** Reads `files[]` from a portal multipart body; oversized ones are reported, not stored. */
export async function readUploads(fd: FormData): Promise<{ files: PortalUpload[]; refused: { fileName: string; error: string }[] }> {
  const files: PortalUpload[] = [];
  const refused: { fileName: string; error: string }[] = [];
  for (const f of fd.getAll("files").filter((x): x is File => x instanceof File).slice(0, 10)) {
    if (f.size > MAX_ATTACHMENT_BYTES) refused.push({ fileName: f.name, error: `larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` });
    else if (f.size > 0) files.push({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) });
  }
  return { files, refused };
}

