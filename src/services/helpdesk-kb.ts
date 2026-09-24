import { and, asc, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { tickets, user } from "@/db/schema";
import { kbArticleRevisions, kbArticles, ticketKbLinks } from "@/db/schema/helpdesk-kb";
import { audit, diffFields } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { markdownExcerpt } from "@/lib/markdown-parse";
import { ticketReference } from "@/lib/validation-helpdesk";
import { recordEvent, type Actor } from "./helpdesk";

export type KbStatus = "draft" | "published" | "archived";
export type KbArticleInput = {
  title: string;
  body: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  customerVisible: boolean;
  reviewDueAt: Date | null;
  changeNote: string | null;
};

const updatedBy = alias(user, "kb_updated_by");
const createdBy = alias(user, "kb_created_by");

export function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "article"
  );
}

async function uniqueSlug(base: string, excludeId: string | null) {
  let slug = base;
  for (let i = 2; i < 100; i++) {
    const [clash] = await db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(eq(kbArticles.slug, slug), excludeId ? ne(kbArticles.id, excludeId) : undefined))
      .limit(1);
    if (!clash) return slug;
    slug = `${base}-${i}`;
  }
  throw new ActionError("Could not find a free slug for this title.");
}

/** Search words are matched against title, summary, tags and body (AND across words). */
function searchWhere(q: string | null | undefined) {
  const words = (q ?? "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (words.length === 0) return undefined;
  return and(
    ...words.map((w) => {
      const like = `%${w}%`;
      return or(
        ilike(kbArticles.title, like),
        ilike(kbArticles.summary, like),
        ilike(kbArticles.body, like),
        sql`exists (select 1 from unnest(${kbArticles.tags}) t where t ilike ${like})`,
      );
    }),
  );
}

export async function listArticles(p: {
  q?: string | null;
  status?: KbStatus | "all" | null;
  category?: string | null;
  customerVisible?: boolean | null;
  limit?: number;
}) {
  const rows = await db
    .select({ a: kbArticles, updatedByName: updatedBy.name })
    .from(kbArticles)
    .leftJoin(updatedBy, eq(updatedBy.id, kbArticles.updatedByUserId))
    .where(
      and(
        p.status && p.status !== "all" ? eq(kbArticles.status, p.status) : p.status === "all" ? undefined : ne(kbArticles.status, "archived"),
        p.category ? eq(kbArticles.category, p.category) : undefined,
        p.customerVisible === true ? eq(kbArticles.customerVisible, true) : undefined,
        searchWhere(p.q),
      ),
    )
    .orderBy(desc(kbArticles.updatedAt))
    .limit(Math.min(p.limit ?? 100, 500));
  return rows.map((r) => ({
    ...r.a,
    updatedByName: r.updatedByName,
    excerpt: r.a.summary ?? markdownExcerpt(r.a.body, 160),
  }));
}

export async function kbCategories() {
  const rows = await db
    .select({ category: kbArticles.category, n: sql<number>`count(*)`.mapWith(Number) })
    .from(kbArticles)
    .where(and(ne(kbArticles.status, "archived"), sql`${kbArticles.category} is not null`))
    .groupBy(kbArticles.category)
    .orderBy(asc(kbArticles.category));
  return rows.map((r) => ({ category: r.category!, n: r.n }));
}

export async function getArticle(idOrSlug: string) {
  const isUuid = /^[0-9a-f-]{36}$/.test(idOrSlug);
  const [row] = await db
    .select({ a: kbArticles, updatedByName: updatedBy.name, createdByName: createdBy.name })
    .from(kbArticles)
    .leftJoin(updatedBy, eq(updatedBy.id, kbArticles.updatedByUserId))
    .leftJoin(createdBy, eq(createdBy.id, kbArticles.createdByUserId))
    .where(isUuid ? eq(kbArticles.id, idOrSlug) : eq(kbArticles.slug, idOrSlug))
    .limit(1);
  if (!row) return null;
  const [revisions, linked] = await Promise.all([
    db
      .select({ r: kbArticleRevisions, editorName: user.name })
      .from(kbArticleRevisions)
      .leftJoin(user, eq(user.id, kbArticleRevisions.editedByUserId))
      .where(eq(kbArticleRevisions.articleId, row.a.id))
      .orderBy(desc(kbArticleRevisions.version)),
    db
      .select({
        l: ticketKbLinks,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
      })
      .from(ticketKbLinks)
      .innerJoin(tickets, eq(tickets.id, ticketKbLinks.ticketId))
      .where(eq(ticketKbLinks.articleId, row.a.id))
      .orderBy(desc(ticketKbLinks.createdAt))
      .limit(50),
  ]);
  return {
    ...row.a,
    updatedByName: row.updatedByName,
    createdByName: row.createdByName,
    revisions: revisions.map((r) => ({ ...r.r, editorName: r.editorName })),
    tickets: linked.map((l) => ({
      id: l.l.ticketId,
      kind: l.l.kind,
      reference: ticketReference(l.number),
      subject: l.subject,
      status: l.status,
      at: l.l.createdAt,
    })),
  };
}
export type KbArticleDetail = NonNullable<Awaited<ReturnType<typeof getArticle>>>;

/** Creates or updates; every content change writes a revision so history is never lost. */
export async function saveArticle(
  id: string | null,
  input: KbArticleInput,
  actorUserId: string,
  opts: { fromTicketId?: string | null } = {},
) {
  const clean = {
    title: input.title.trim(),
    body: input.body,
    summary: input.summary?.trim() || null,
    category: input.category?.trim() || null,
    tags: [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
    customerVisible: input.customerVisible,
    reviewDueAt: input.reviewDueAt,
  };
  if (!clean.title) throw new ActionError("Title is required.", { title: ["Required"] });
  const articleId = await db.transaction(async (tx) => {
    if (id) {
      const [existing] = await tx.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
      if (!existing) throw new ActionError("Article not found.");
      const changes = diffFields(
        { title: existing.title, body: existing.body, summary: existing.summary, category: existing.category, tags: existing.tags, customerVisible: existing.customerVisible, reviewDueAt: existing.reviewDueAt },
        clean,
      );
      if (Object.keys(changes).length === 0 && !input.changeNote) return existing.id;
      const contentChanged = "title" in changes || "body" in changes || "summary" in changes;
      const version = contentChanged ? existing.version + 1 : existing.version;
      const slug = "title" in changes ? await uniqueSlug(slugify(clean.title), id) : existing.slug;
      await tx
        .update(kbArticles)
        .set({ ...clean, slug, version, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(kbArticles.id, id));
      if (contentChanged)
        await tx.insert(kbArticleRevisions).values({
          articleId: id,
          version,
          title: clean.title,
          body: clean.body,
          summary: clean.summary,
          editedByUserId: actorUserId,
          note: input.changeNote,
        });
      await audit(
        {
          actorUserId,
          action: "kb.article.update",
          entityType: "kb_article",
          entityId: id,
          details: { changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, k === "body" ? "changed" : v])), version },
        },
        tx,
      );
      return id;
    }
    const slug = await uniqueSlug(slugify(clean.title), null);
    const [row] = await tx
      .insert(kbArticles)
      .values({ ...clean, slug, createdByUserId: actorUserId, updatedByUserId: actorUserId })
      .returning({ id: kbArticles.id });
    await tx.insert(kbArticleRevisions).values({
      articleId: row.id,
      version: 1,
      title: clean.title,
      body: clean.body,
      summary: clean.summary,
      editedByUserId: actorUserId,
      note: input.changeNote ?? "Created",
    });
    if (opts.fromTicketId)
      await tx
        .insert(ticketKbLinks)
        .values({ ticketId: opts.fromTicketId, articleId: row.id, kind: "created_from", linkedByUserId: actorUserId })
        .onConflictDoNothing();
    await audit(
      {
        actorUserId,
        action: "kb.article.create",
        entityType: "kb_article",
        entityId: row.id,
        details: { title: clean.title, fromTicketId: opts.fromTicketId ?? null },
      },
      tx,
    );
    return row.id;
  });
  if (opts.fromTicketId && !id)
    await recordEvent(opts.fromTicketId, "kb", `Knowledge article written from this ticket: ${clean.title}`, { id: actorUserId, type: "user" }, { articleId });
  return articleId;
}

/** Publish, unpublish (back to draft) or archive. Publishing requires a body. */
export async function setArticleStatus(id: string, status: KbStatus, actorUserId: string) {
  const [a] = await db.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
  if (!a) throw new ActionError("Article not found.");
  if (status === "published" && !a.body.trim()) throw new ActionError("Write the article before publishing it.");
  await db
    .update(kbArticles)
    .set({
      status,
      publishedAt: status === "published" ? (a.publishedAt ?? new Date()) : a.publishedAt,
      updatedByUserId: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(kbArticles.id, id));
  await audit({ actorUserId, action: `kb.article.${status}`, entityType: "kb_article", entityId: id, details: { title: a.title } });
}

export async function deleteArticle(id: string, actorUserId: string) {
  const [a] = await db.delete(kbArticles).where(eq(kbArticles.id, id)).returning({ title: kbArticles.title });
  if (a) await audit({ actorUserId, action: "kb.article.delete", entityType: "kb_article", entityId: id, details: { title: a.title } });
}

export async function restoreRevision(id: string, version: number, actorUserId: string) {
  const [rev] = await db
    .select()
    .from(kbArticleRevisions)
    .where(and(eq(kbArticleRevisions.articleId, id), eq(kbArticleRevisions.version, version)))
    .limit(1);
  if (!rev) throw new ActionError("Revision not found.");
  const [a] = await db.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
  if (!a) throw new ActionError("Article not found.");
  return saveArticle(
    id,
    {
      title: rev.title,
      body: rev.body,
      summary: rev.summary,
      category: a.category,
      tags: a.tags,
      customerVisible: a.customerVisible,
      reviewDueAt: a.reviewDueAt,
      changeNote: `Restored version ${version}`,
    },
    actorUserId,
  );
}

export async function recordArticleView(id: string) {
  await db.update(kbArticles).set({ viewCount: sql`${kbArticles.viewCount} + 1` }).where(eq(kbArticles.id, id));
}

// ---------------------------------------------------------------------------
// Tickets ↔ articles
// ---------------------------------------------------------------------------
export async function linkArticleToTicket(ticketId: string, articleId: string, actor: Actor, kind: "linked" | "sent" = "linked") {
  const [a] = await db.select({ id: kbArticles.id, title: kbArticles.title, status: kbArticles.status }).from(kbArticles).where(eq(kbArticles.id, articleId)).limit(1);
  if (!a) throw new ActionError("Article not found.");
  const inserted = await db
    .insert(ticketKbLinks)
    .values({ ticketId, articleId, kind, linkedByUserId: actor.id })
    .onConflictDoUpdate({
      target: [ticketKbLinks.ticketId, ticketKbLinks.articleId],
      set: { kind: sql`case when ${ticketKbLinks.kind} = 'created_from' then ${ticketKbLinks.kind} else ${kind} end` },
    })
    .returning({ id: ticketKbLinks.id });
  if (kind === "sent") await db.update(kbArticles).set({ usedCount: sql`${kbArticles.usedCount} + 1` }).where(eq(kbArticles.id, articleId));
  await recordEvent(ticketId, "kb", `${kind === "sent" ? "Article sent to the customer" : "Article linked"}: ${a.title}`, actor, { articleId, kind });
  return inserted[0]?.id ?? null;
}

export async function unlinkArticleFromTicket(ticketId: string, articleId: string, actor: Actor) {
  const [row] = await db
    .delete(ticketKbLinks)
    .where(and(eq(ticketKbLinks.ticketId, ticketId), eq(ticketKbLinks.articleId, articleId)))
    .returning({ id: ticketKbLinks.id });
  if (row) await recordEvent(ticketId, "kb", "Article link removed", actor, { articleId });
}

export async function ticketArticles(ticketId: string) {
  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      status: kbArticles.status,
      customerVisible: kbArticles.customerVisible,
      kind: ticketKbLinks.kind,
    })
    .from(ticketKbLinks)
    .innerJoin(kbArticles, eq(kbArticles.id, ticketKbLinks.articleId))
    .where(eq(ticketKbLinks.ticketId, ticketId))
    .orderBy(desc(ticketKbLinks.createdAt));
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "not", "are", "our", "your", "has", "have", "can", "cannot", "into", "when", "after", "before", "still", "does", "please", "help", "issue", "problem", "error"]);

/** Published articles whose title, tags or summary share words with the ticket subject; a lightweight suggestion, never authoritative. */
export async function suggestArticles(subject: string, excludeIds: string[] = [], limit = 5) {
  const words = [...new Set(subject.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);
  if (words.length === 0) return [];
  const rows = await db
    .select({ id: kbArticles.id, title: kbArticles.title, slug: kbArticles.slug, summary: kbArticles.summary, body: kbArticles.body, tags: kbArticles.tags, customerVisible: kbArticles.customerVisible })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.status, "published"),
        excludeIds.length ? sql`${kbArticles.id} not in (${sql.join(excludeIds.map((i) => sql`${i}`), sql`, `)})` : undefined,
        or(...words.map((w) => or(ilike(kbArticles.title, `%${w}%`), ilike(kbArticles.summary, `%${w}%`), sql`exists (select 1 from unnest(${kbArticles.tags}) t where t ilike ${`%${w}%`})`))),
      ),
    )
    .limit(50);
  return rows
    .map((r) => {
      const hay = `${r.title} ${r.summary ?? ""} ${r.tags.join(" ")}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { id: r.id, title: r.title, slug: r.slug, customerVisible: r.customerVisible, excerpt: r.summary ?? markdownExcerpt(r.body, 120), score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Articles the composer may insert: customer replies get customer-visible published ones, notes get everything published. */
export async function insertableArticles(forCustomer: boolean) {
  return db
    .select({ id: kbArticles.id, title: kbArticles.title, slug: kbArticles.slug, category: kbArticles.category, customerVisible: kbArticles.customerVisible })
    .from(kbArticles)
    .where(and(eq(kbArticles.status, "published"), forCustomer ? eq(kbArticles.customerVisible, true) : undefined))
    .orderBy(asc(kbArticles.category), asc(kbArticles.title));
}

/** Body to insert into a reply: never internal-only content into a customer message. */
export async function articleBodyForInsert(articleId: string, forCustomer: boolean) {
  const [a] = await db.select().from(kbArticles).where(eq(kbArticles.id, articleId)).limit(1);
  if (!a || a.status !== "published") throw new ActionError("Only published articles can be inserted.");
  if (forCustomer && !a.customerVisible) throw new ActionError("This article is internal and cannot be sent to a customer.");
  return { title: a.title, body: a.body };
}

export async function kbStats() {
  const [row] = await db
    .select({
      published: sql<number>`count(*) filter (where ${kbArticles.status} = 'published')`.mapWith(Number),
      drafts: sql<number>`count(*) filter (where ${kbArticles.status} = 'draft')`.mapWith(Number),
      customerVisible: sql<number>`count(*) filter (where ${kbArticles.status} = 'published' and ${kbArticles.customerVisible})`.mapWith(Number),
      reviewDue: sql<number>`count(*) filter (where ${kbArticles.status} = 'published' and ${kbArticles.reviewDueAt} < now())`.mapWith(Number),
    })
    .from(kbArticles);
  return row;
}

