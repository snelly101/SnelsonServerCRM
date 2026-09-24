import { describe, expect, it, beforeAll } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { activities, auditLog, companyNotes } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { archiveNote, createNote, listCompanyNotes, noteCounts, setNotePinned, updateNote } from "@/services/notes";
import { markdownExcerpt, parseBlocks, safeHref } from "@/lib/markdown-parse";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };
let companyId: string;

beforeAll(async () => {
  admin = await makeUser("admin", "notes admin");
  companyId = await createCompany(companySchema.parse({ name: "Notes Test Co", status: "customer" }), admin.id);
});

describe("markdown-lite", () => {
  it("parses headings, paragraphs, lists and rules, and never emits raw HTML", () => {
    const blocks = parseBlocks("# Access\n\nRing the bell.\nAsk for **Sam**.\n\n- Key safe: 1234\n- Badge\n\n1. First\n2. Second\n\n---\n<script>alert(1)</script>");
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "ul", "ol", "hr", "p"]);
    expect(blocks[1]).toEqual({ type: "p", lines: ["Ring the bell.", "Ask for **Sam**."] });
    expect(blocks[2]).toEqual({ type: "ul", items: ["Key safe: 1234", "Badge"] });
    // The script tag is just text inside a paragraph; the renderer builds elements, never innerHTML.
    expect(blocks[5]).toEqual({ type: "p", lines: ["<script>alert(1)</script>"] });
  });
  it("only allows http(s), mailto and tel links", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
  });
  it("makes a plain-text excerpt", () => {
    expect(markdownExcerpt("## Title\n- **bold** item\n[link](https://x)")).toBe("Title bold item link");
    expect(markdownExcerpt("a".repeat(200), 20)).toHaveLength(20);
  });
});

describe("company notes", () => {
  it("creates, lists pinned first, updates with an audited field diff, pins and archives", async () => {
    const a = await createNote(companyId, { title: "Escalation", body: "Call **Dana** first.", pinned: false }, admin.id);
    const b = await createNote(companyId, { title: "Site access", body: "- Key safe 1234", pinned: true }, admin.id);
    let list = await listCompanyNotes(companyId);
    expect(list.map((n) => n.id)).toEqual([b, a]);
    expect(list[0].updatedByName).toBe("notes admin");
    expect(await noteCounts(companyId)).toEqual({ total: 2, pinned: 1 });

    expect(await updateNote(a, { title: "Escalation", body: "Call **Dana** first.", pinned: false }, admin.id)).toEqual({ changed: false });
    expect(await updateNote(a, { title: "Escalation path", body: "Call **Dana** first, then Ops.", pinned: false }, admin.id)).toEqual({ changed: true });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "note.update")).orderBy(desc(auditLog.at)).limit(1);
    const changes = (entry.details as { changes: Record<string, { from: unknown; to: unknown }> }).changes;
    expect(changes.title).toEqual({ from: "Escalation", to: "Escalation path" });
    expect(changes.body.to).toBe("Call **Dana** first, then Ops.");
    expect(changes.pinned).toBeUndefined();

    await setNotePinned(a, true, admin.id);
    list = await listCompanyNotes(companyId);
    expect(list.every((n) => n.pinned)).toBe(true);

    await archiveNote(b, false, admin.id);
    expect((await listCompanyNotes(companyId)).map((n) => n.id)).toEqual([a]);
    expect((await listCompanyNotes(companyId, { includeArchived: true })).find((n) => n.id === b)?.pinned).toBe(false);
    await expect(updateNote(b, { title: "x", body: "", pinned: false }, admin.id)).rejects.toBeInstanceOf(ActionError);
    await archiveNote(b, true, admin.id);
    expect((await listCompanyNotes(companyId)).map((n) => n.id).sort()).toEqual([a, b].sort());
    const timeline = await db.select({ title: activities.title }).from(activities).where(eq(activities.companyId, companyId));
    expect(timeline.map((t) => t.title)).toEqual(expect.arrayContaining(["Note added: Escalation", "Note updated: Escalation path", "Note archived: Site access", "Note restored: Site access"]));
  });

  it("turns free-text notes on company creation (CSV import) into a pinned note instead of the legacy column", async () => {
    const id = await createCompany(companySchema.parse({ name: "Imported Notes Ltd", status: "prospect", notes: "Prefers email. Closed Fridays." }), admin.id);
    const notes = await listCompanyNotes(id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Internal notes", body: "Prefers email. Closed Fridays.", pinned: true });
    const [row] = await db.select({ legacy: companyNotes.companyId }).from(companyNotes).where(eq(companyNotes.companyId, id));
    expect(row.legacy).toBe(id);
  });
});
