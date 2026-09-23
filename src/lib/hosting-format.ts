export const HOSTING_KIND_TONE: Record<string, string> = { package: "indigo", domain: "blue", mailbox: "slate", ssl: "green" };
export const HOSTING_KIND_LABEL: Record<string, string> = { package: "package", domain: "domain", mailbox: "mailbox", ssl: "SSL" };

export function fmtBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Badge tone and label for a date-only expiry; null when there is no date. */
export function expiryTone(expiresOn: string | null | undefined): { tone: string; label: string } | null {
  if (!expiresOn) return null;
  const days = Math.ceil((new Date(expiresOn).getTime() - Date.now()) / 86400000);
  if (days < 0) return { tone: "red", label: `expired ${-days}d ago` };
  if (days <= 30) return { tone: "amber", label: `${days}d left` };
  return { tone: "slate", label: `${days}d left` };
}
