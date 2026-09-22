import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/connectors/xero/live";
import { recordXeroWebhookEvents, type XeroWebhookEvent } from "@/services/xero";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Xero webhook receiver.
 * - Verifies base64(HMAC-SHA256(rawBody, XERO_WEBHOOK_KEY)) against x-xero-signature.
 * - Returns 401 on a bad signature (Xero's "intent to receive" check relies on this).
 * - Records events idempotently and returns 200 within Xero's 5 s deadline;
 *   the worker fetches the changed resources afterwards.
 */
export async function POST(req: Request) {
  const key = process.env.XERO_WEBHOOK_KEY;
  if (!key) return new NextResponse("Webhook key not configured", { status: 401 });
  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get("x-xero-signature"), key)) {
    logger.warn("xero webhook: signature mismatch");
    return new NextResponse(null, { status: 401 });
  }
  let payload: { events?: XeroWebhookEvent[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 200 }); // intent-to-receive may send an empty events list
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  try {
    const recorded = await recordXeroWebhookEvents(events);
    logger.info({ received: events.length, recorded }, "xero webhook");
  } catch (err) {
    // Never fail the delivery: reconciliation will pick it up.
    logger.error({ err }, "xero webhook: failed to record events");
  }
  return new NextResponse(null, { status: 200 });
}
