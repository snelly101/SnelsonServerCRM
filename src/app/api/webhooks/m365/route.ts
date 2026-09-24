import { NextResponse, type NextRequest } from "next/server";
import {
  handleGraphNotifications,
  type GraphNotificationPayload,
} from "@/services/mailbox";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Microsoft Graph change notifications for the support mailbox.
 * - Validation handshake: Graph POSTs ?validationToken=… and expects the
 *   token back as text/plain within 10 seconds.
 * - Notifications: each entry is checked against the stored clientState of
 *   the subscription it names; matching ones are enqueued durably and the
 *   request returns 202 at once. Processing happens in the worker.
 * - Lifecycle notifications arrive on the same URL with ?lifecycle=1 and
 *   are handled through the same path (re-subscribe, delta recovery).
 */
export async function POST(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken)
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  let payload: GraphNotificationPayload;
  try {
    payload = (await req.json()) as GraphNotificationPayload;
  } catch {
    return new NextResponse(null, { status: 202 });
  }
  try {
    const results = await handleGraphNotifications(payload);
    if (results.some((r) => r.outcome.startsWith("rejected")))
      logger.warn({ results }, "m365 notification(s) rejected");
  } catch (err) {
    // Never fail the webhook: Graph would retry and eventually drop the subscription. Delta sync recovers.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "m365 notification handling failed",
    );
  }
  return new NextResponse(null, { status: 202 });
}

export async function GET(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken)
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  return new NextResponse("ok", { status: 200 });
}
