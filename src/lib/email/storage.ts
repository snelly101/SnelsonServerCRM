import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

/**
 * Private attachment storage on local disk (a Docker volume in production)
 * plus optional ClamAV scanning over the clamd INSTREAM protocol. Nothing in
 * here is reachable from the web without going through the authorised
 * download route.
 */
export const ATTACHMENT_ROOT = path.resolve(
  process.env.DATA_DIR ?? "./data",
  "attachments",
);
export const MAX_ATTACHMENT_BYTES =
  Math.max(1, Number(process.env.HELPDESK_MAX_ATTACHMENT_MB ?? 25)) *
  1024 *
  1024;
export const BLOCKED_EXTENSIONS = new Set(
  (
    process.env.HELPDESK_BLOCKED_EXTENSIONS ??
    "exe,msi,bat,cmd,com,scr,pif,ps1,vbs,vbe,js,jse,wsf,wsh,hta,cpl,jar,reg,lnk,iso,img,dll,sys"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function extensionOf(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}
export function checkAttachmentPolicy(
  name: string,
  size: number,
): string | null {
  const ext = extensionOf(name);
  if (ext && BLOCKED_EXTENSIONS.has(ext))
    return `.${ext} files are not accepted`;
  if (size > MAX_ATTACHMENT_BYTES)
    return `larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`;
  return null;
}

export function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes bytes under <root>/<scope>/<yyyy>/<mm>/<id>; returns the relative path. */
export async function storeAttachmentBytes(
  scope: string,
  id: string,
  bytes: Buffer,
) {
  const now = new Date();
  const rel = path.join(
    scope.replace(/[^a-z0-9_-]/gi, "_"),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    id,
  );
  const abs = path.join(ATTACHMENT_ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes, { mode: 0o600 });
  return rel;
}
export async function readAttachmentBytes(rel: string) {
  const abs = path.join(ATTACHMENT_ROOT, rel);
  if (!abs.startsWith(ATTACHMENT_ROOT))
    throw new Error("Invalid attachment path");
  return readFile(abs);
}
export async function deleteAttachmentBytes(rel: string) {
  const abs = path.join(ATTACHMENT_ROOT, rel);
  if (!abs.startsWith(ATTACHMENT_ROOT)) return;
  await rm(abs, { force: true });
}
export async function attachmentExists(rel: string) {
  try {
    await stat(path.join(ATTACHMENT_ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

export type ScanResult = {
  status: "clean" | "blocked" | "skipped" | "error";
  detail: string | null;
};

/**
 * Scans with clamd when CLAMAV_HOST is set (INSTREAM over TCP); otherwise
 * "skipped" so the deployment decides. A scanner failure never loses the
 * file: the attachment stays stored with status "error" and is not
 * downloadable until re-scanned.
 */
export async function scanBytes(bytes: Buffer): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return { status: "skipped", detail: "no scanner configured" };
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let response = "";
    const done = (r: ScanResult) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(Number(process.env.CLAMAV_TIMEOUT_MS ?? 30_000), () =>
      done({ status: "error", detail: "scanner timeout" }),
    );
    sock.on("error", (err) => done({ status: "error", detail: err.message }));
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      const chunk = 64 * 1024;
      for (let i = 0; i < bytes.length; i += chunk) {
        const part = bytes.subarray(i, Math.min(i + chunk, bytes.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.from([0, 0, 0, 0]));
    });
    sock.on("data", (d) => (response += d.toString()));
    sock.on("end", () => {
      const r = response.replace(/\0/g, "").trim();
      if (/OK$/.test(r)) done({ status: "clean", detail: null });
      else if (/FOUND$/.test(r))
        done({
          status: "blocked",
          detail: r.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, ""),
        });
      else done({ status: "error", detail: r || "empty scanner response" });
    });
  });
}
