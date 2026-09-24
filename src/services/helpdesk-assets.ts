import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ninjaDevices, ninjaOrganizations, tickets } from "@/db/schema";
import { ticketAssets } from "@/db/schema/helpdesk-kb";
import { ActionError } from "@/lib/action-result";
import { ticketReference } from "@/lib/validation-helpdesk";
import { recordEvent, type Actor } from "./helpdesk";

/** Devices linked to a ticket, with the live mirror state so the agent sees offline/patch/threat flags in the side panel. */
export async function ticketDevices(ticketId: string) {
  return db
    .select({
      linkId: ticketAssets.id,
      note: ticketAssets.note,
      id: ninjaDevices.id,
      deviceId: ninjaDevices.deviceId,
      displayName: ninjaDevices.displayName,
      systemName: ninjaDevices.systemName,
      nodeClass: ninjaDevices.nodeClass,
      offline: ninjaDevices.offline,
      lastContact: ninjaDevices.lastContact,
      osName: ninjaDevices.osName,
      healthStatus: ninjaDevices.healthStatus,
      needsReboot: ninjaDevices.needsReboot,
      activeThreats: ninjaDevices.activeThreats,
      pendingOsPatches: ninjaDevices.pendingOsPatches,
      externalStatus: ninjaDevices.externalStatus,
      companyId: ninjaDevices.companyId,
      orgName: ninjaOrganizations.name,
    })
    .from(ticketAssets)
    .innerJoin(ninjaDevices, eq(ninjaDevices.id, ticketAssets.deviceId))
    .leftJoin(ninjaOrganizations, eq(ninjaOrganizations.orgId, ninjaDevices.orgId))
    .where(eq(ticketAssets.ticketId, ticketId))
    .orderBy(desc(ticketAssets.createdAt));
}

/** Candidate devices for the picker: the requester's company first; anything else only when the ticket has no company. */
export async function deviceOptionsForTicket(ticketId: string) {
  const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) return [];
  return db
    .select({
      id: ninjaDevices.id,
      displayName: ninjaDevices.displayName,
      systemName: ninjaDevices.systemName,
      nodeClass: ninjaDevices.nodeClass,
      offline: ninjaDevices.offline,
      companyId: ninjaDevices.companyId,
    })
    .from(ninjaDevices)
    .where(and(eq(ninjaDevices.externalStatus, "active"), t.companyId ? eq(ninjaDevices.companyId, t.companyId) : isNull(ninjaDevices.companyId)))
    .orderBy(ninjaDevices.displayName)
    .limit(300);
}

export async function linkDevice(ticketId: string, deviceId: string, actor: Actor, note: string | null = null) {
  const [d] = await db
    .select({ id: ninjaDevices.id, name: ninjaDevices.displayName, systemName: ninjaDevices.systemName, companyId: ninjaDevices.companyId })
    .from(ninjaDevices)
    .where(eq(ninjaDevices.id, deviceId))
    .limit(1);
  if (!d) throw new ActionError("Device not found.");
  const [t] = await db.select({ companyId: tickets.companyId, number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  // A device belongs to one customer; linking another customer's device would leak its details into the wrong record.
  if (t.companyId && d.companyId && t.companyId !== d.companyId)
    throw new ActionError("That device belongs to a different customer than this ticket.");
  const [row] = await db
    .insert(ticketAssets)
    .values({ ticketId, deviceId, note, linkedByUserId: actor.id })
    .onConflictDoNothing()
    .returning({ id: ticketAssets.id });
  if (row)
    await recordEvent(ticketId, "asset", `Device linked: ${d.name ?? d.systemName ?? "device"}`, actor, { deviceId, note });
  return row?.id ?? null;
}

export async function unlinkDevice(ticketId: string, deviceId: string, actor: Actor) {
  const [row] = await db
    .delete(ticketAssets)
    .where(and(eq(ticketAssets.ticketId, ticketId), eq(ticketAssets.deviceId, deviceId)))
    .returning({ id: ticketAssets.id });
  if (row) await recordEvent(ticketId, "asset", "Device link removed", actor, { deviceId });
}

/** Tickets that mention a device: for the device page and the customer's device tab. */
export async function deviceTickets(deviceId: string, limit = 20) {
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, subject: tickets.subject, status: tickets.status, priority: tickets.priority, lastActivityAt: tickets.lastActivityAt })
    .from(ticketAssets)
    .innerJoin(tickets, eq(tickets.id, ticketAssets.ticketId))
    .where(eq(ticketAssets.deviceId, deviceId))
    .orderBy(desc(tickets.lastActivityAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, reference: ticketReference(r.number) }));
}
