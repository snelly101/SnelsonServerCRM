import type { GraphMessage } from "@/connectors/m365/types";
import { header, recipient } from "@/connectors/m365/types";

export type AutomatedKind =
  | "bounce"
  | "auto_reply"
  | "out_of_office"
  | "bulk"
  | "system"
  | null;

/**
 * Classifies machine-generated mail so it never triggers acknowledgements,
 * reopens or "customer replied" events. Checks RFC 3834 / Microsoft headers
 * first, then well-known senders and subjects.
 */
export function classifyAutomated(msg: GraphMessage): {
  kind: AutomatedKind;
  reason: string | null;
} {
  const h = (n: string) => (header(msg, n) ?? "").toLowerCase();
  const from = recipient(msg.from)?.email ?? "";
  const subject = (msg.subject ?? "").toLowerCase();
  const contentType = h("content-type");
  if (
    contentType.includes("multipart/report") ||
    contentType.includes("report-type=delivery-status")
  )
    return { kind: "bounce", reason: "delivery status report" };
  if (
    /^(mailer-daemon|postmaster)@/.test(from) ||
    /^(mailer-daemon|postmaster)$/.test(from.split("@")[0] ?? "")
  )
    return { kind: "bounce", reason: `from ${from}` };
  if (
    /^(undeliverable|undelivered mail returned|delivery status notification|mail delivery failed|delivery failure|returned mail|delivery has failed)/.test(
      subject,
    )
  )
    return { kind: "bounce", reason: "delivery failure subject" };
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no")
    return {
      kind: autoSubmitted.includes("auto-replied") ? "auto_reply" : "system",
      reason: `Auto-Submitted: ${autoSubmitted}`,
    };
  if (h("x-auto-response-suppress"))
    return { kind: "auto_reply", reason: "X-Auto-Response-Suppress" };
  if (h("x-autoreply") || h("x-autorespond"))
    return { kind: "auto_reply", reason: "X-Autoreply" };
  if (
    /^(automatic reply|auto reply|autoreply|out of office|out of the office|ooo:)/.test(
      subject,
    ) ||
    subject.includes("automatic reply:") ||
    subject.includes("out of office")
  )
    return { kind: "out_of_office", reason: "out-of-office subject" };
  const precedence = h("precedence");
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence))
    return { kind: "bulk", reason: `Precedence: ${precedence}` };
  if (h("list-id") || h("list-unsubscribe"))
    return { kind: "bulk", reason: "mailing list headers" };
  if (/^(no-?reply|do-?not-?reply|donotreply)@/.test(from))
    return { kind: "system", reason: `from ${from}` };
  return { kind: null, reason: null };
}

/** Pulls the failed recipient and the original Message-ID out of a bounce so it can be tied to what we sent. */
export function bounceDetails(msg: GraphMessage, bodyText: string) {
  const failed =
    header(msg, "X-Failed-Recipients") ??
    bodyText.match(
      /(?:recipient|address|to)\s*:?\s*<?([^\s<>@]+@[^\s<>]+)>?/i,
    )?.[1] ??
    null;
  const originalId =
    bodyText.match(/Message-ID:\s*(<[^>]+>)/i)?.[1] ??
    bodyText.match(/(<[^<>\s]+@[^<>\s]+>)/)?.[1] ??
    null;
  return {
    failedRecipient: failed?.toLowerCase() ?? null,
    originalMessageId: originalId,
  };
}
