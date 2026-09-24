import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { companyNotes, user } from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";

export type NoteInput = { title: string; body: string; pinned: boolean };

const updatedBy = alias(user, "updated_by");
const createdBy = alias(user, "created_by");

/** Notes for one company: pinned first, then most recently edited. Archived ones only on request. */
export async function listCompanyNotes(
  companyId: string,
  opts?: { includeArchived?: boolean },
) {
  const rows = await db
    .select({
      note: companyNotes,
      updatedByName: updatedBy.name,
      createdByName: createdBy.name,
    })
    .from(companyNotes)
    .leftJoin(updatedBy, eq(updatedBy.id, companyNotes.updatedByUserId))
    .leftJoin(createdBy, eq(createdBy.id, companyNotes.createdByUserId))
    .where(
      and(
        eq(companyNotes.companyId, companyId),
        opts?.includeArchived ? undefined : isNull(companyNotes.archivedAt),
      ),
    )
    .orderBy(
      desc(companyNotes.pinned),
      desc(companyNotes.updatedAt),
      asc(companyNotes.title),
    );
  return rows.map((r) => ({
    ...r.note,
    updatedByName: r.updatedByName,
    createdByName: r.createdByName,
  }));
}

export async function getNote(id: string) {
  const [row] = await db
    .select()
    .from(companyNotes)
    .where(eq(companyNotes.id, id))
    .limit(1);
  return row ?? null;
}

export async function createNote(
  companyId: string,
  input: NoteInput,
  actorUserId: string | null,
  tx: Tx | typeof db = db,
) {
  const [row] = await tx
    .insert(companyNotes)
    .values({
      companyId,
      title: input.title,
      body: input.body,
      pinned: input.pinned,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    .returning({ id: companyNotes.id });
  await audit(
    {
      actorUserId,
      action: "note.create",
      entityType: "company_note",
      entityId: row.id,
      details: {
        companyId,
        title: input.title,
        pinned: input.pinned,
        bodyLength: input.body.length,
      },
    },
    tx,
  );
  await logActivity(
    {
      type: "system",
      companyId,
      entityType: "company_note",
      entityId: row.id,
      title: `Note added: ${input.title}`,
      actorUserId,
    },
    tx,
  );
  return row.id;
}

/** Every save records a field-level diff (title, pinned, and the body text before/after) in the audit log. */
export async function updateNote(
  id: string,
  input: NoteInput,
  actorUserId: string,
) {
  const existing = await getNote(id);
  if (!existing || existing.archivedAt)
    throw new ActionError("Note not found.");
  const changes = diffFields(
    { title: existing.title, body: existing.body, pinned: existing.pinned },
    { title: input.title, body: input.body, pinned: input.pinned },
  );
  if (Object.keys(changes).length === 0) return { changed: false };
  await db.transaction(async (tx) => {
    await tx
      .update(companyNotes)
      .set({
        title: input.title,
        body: input.body,
        pinned: input.pinned,
        updatedByUserId: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(companyNotes.id, id));
    await audit(
      {
        actorUserId,
        action: "note.update",
        entityType: "company_note",
        entityId: id,
        details: { companyId: existing.companyId, changes },
      },
      tx,
    );
    await logActivity(
      {
        type: "system",
        companyId: existing.companyId,
        entityType: "company_note",
        entityId: id,
        title: `Note updated: ${input.title}${"body" in changes ? "" : " (title or pin only)"}`,
        actorUserId,
      },
      tx,
    );
  });
  return { changed: true };
}

export async function setNotePinned(
  id: string,
  pinned: boolean,
  actorUserId: string,
) {
  const existing = await getNote(id);
  if (!existing || existing.archivedAt)
    throw new ActionError("Note not found.");
  if (existing.pinned === pinned) return;
  await db.transaction(async (tx) => {
    await tx
      .update(companyNotes)
      .set({ pinned, updatedByUserId: actorUserId, updatedAt: new Date() })
      .where(eq(companyNotes.id, id));
    await audit(
      {
        actorUserId,
        action: pinned ? "note.pin" : "note.unpin",
        entityType: "company_note",
        entityId: id,
        details: { companyId: existing.companyId, title: existing.title },
      },
      tx,
    );
  });
}

/** Soft delete: the note leaves the page but stays in the database and the audit trail. */
export async function archiveNote(
  id: string,
  restore: boolean,
  actorUserId: string,
) {
  const existing = await getNote(id);
  if (!existing) throw new ActionError("Note not found.");
  await db.transaction(async (tx) => {
    await tx
      .update(companyNotes)
      .set({
        archivedAt: restore ? null : new Date(),
        pinned: restore ? existing.pinned : false,
        updatedByUserId: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(companyNotes.id, id));
    await audit(
      {
        actorUserId,
        action: restore ? "note.restore" : "note.archive",
        entityType: "company_note",
        entityId: id,
        details: { companyId: existing.companyId, title: existing.title },
      },
      tx,
    );
    await logActivity(
      {
        type: "system",
        companyId: existing.companyId,
        entityType: "company_note",
        entityId: id,
        title: `${restore ? "Note restored" : "Note archived"}: ${existing.title}`,
        actorUserId,
      },
      tx,
    );
  });
}

export async function noteCounts(companyId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where archived_at is null)`.mapWith(
        Number,
      ),
      pinned:
        sql<number>`count(*) filter (where archived_at is null and pinned)`.mapWith(
          Number,
        ),
    })
    .from(companyNotes)
    .where(eq(companyNotes.companyId, companyId));
  return row;
}
