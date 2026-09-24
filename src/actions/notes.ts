"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { companyNoteSchema } from "@/lib/validation";
import { archiveNote, createNote, getNote, setNotePinned, updateNote } from "@/services/notes";

const revalidate = (companyId: string) => revalidatePath(`/companies/${companyId}`, "page");

export async function saveNoteAction(noteId: string | null, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const companyId = z.uuid().parse(fd.get("companyId"));
    const input = companyNoteSchema.parse({ title: fd.get("title"), body: fd.get("body") ?? "", pinned: fd.get("pinned") === "on" || fd.get("pinned") === "true" });
    let id = noteId;
    if (id) {
      const existing = await getNote(z.uuid().parse(id));
      if (!existing || existing.companyId !== companyId) throw new Error("Note not found.");
      await updateNote(id, input, u.id);
    } else {
      id = await createNote(companyId, input, u.id);
    }
    revalidate(companyId);
    return { id };
  });
}

export async function pinNoteAction(noteId: string, pinned: boolean): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const note = await getNote(z.uuid().parse(noteId));
    if (!note) throw new Error("Note not found.");
    await setNotePinned(note.id, pinned, u.id);
    revalidate(note.companyId);
    return undefined;
  });
}

export async function archiveNoteAction(noteId: string, restore: boolean): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const note = await getNote(z.uuid().parse(noteId));
    if (!note) throw new Error("Note not found.");
    await archiveNote(note.id, restore, u.id);
    revalidate(note.companyId);
    return undefined;
  });
}
