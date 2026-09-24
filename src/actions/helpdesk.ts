"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import {
  bulkActionSchema,
  categorySchema,
  participantSchema,
  splitSchema,
  teamSchema,
  ticketCreateSchema,
  ticketFieldsSchema,
  ticketLinkSchema,
  ticketMessageSchema,
  ticketStatusSchema,
  timeEntrySchema,
} from "@/lib/validation-helpdesk";
import {
  addMessage,
  addParticipant,
  addTimeEntry,
  assignTicket,
  bulkUpdate,
  changeStatus,
  createTicket,
  deleteCategory,
  deleteTeam,
  deleteTimeEntry,
  linkTickets,
  mergePreview,
  mergeTickets,
  removeParticipant,
  saveCategory,
  saveDraft,
  saveTeam,
  splitTicket,
  startTimer,
  stopTimer,
  toggleFollower,
  unlinkTickets,
  updateTicketFields,
} from "@/services/helpdesk";

const revalidate = (id?: string) => {
  revalidatePath("/helpdesk", "layout");
  revalidatePath("/companies", "layout");
  revalidatePath("/contacts", "layout");
  if (id) revalidatePath(`/helpdesk/tickets/${id}`);
};
const csv = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function createTicketAction(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const raw = formToObject(fd) as Record<string, unknown>;
    const customFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw))
      if (k.startsWith("cf.")) customFields[k.slice(3)] = v;
    const input = ticketCreateSchema.parse({ ...raw, customFields });
    const id = await createTicket(input, { id: u.id, type: "user" });
    revalidate();
    return { id };
  });
}

export async function updateTicketFieldsAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const raw = formToObject(fd) as Record<string, unknown>;
    const customFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw))
      if (k.startsWith("cf.")) customFields[k.slice(3)] = v;
    const input = ticketFieldsSchema.parse({ ...raw, customFields });
    const r = await updateTicketFields(z.uuid().parse(id), input, {
      id: u.id,
      type: "user",
    });
    revalidate(id);
    return { version: r.version };
  });
}

export async function changeStatusAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = ticketStatusSchema.parse(formToObject(fd));
    const r = await changeStatus(
      z.uuid().parse(id),
      input.status,
      { id: u.id, type: "user" },
      {
        resolutionSummary: input.resolutionSummary,
        resolutionCategory: input.resolutionCategory,
        version: input.version,
      },
    );
    revalidate(id);
    return { version: r.version };
  });
}

export async function assignTicketAction(
  id: string,
  target: { assigneeUserId?: string | null; teamId?: string | null },
  version?: number,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    // Agents may take or release a ticket for themselves; assigning to others or changing team needs manage.
    const toOther =
      target.assigneeUserId !== undefined &&
      target.assigneeUserId !== null &&
      target.assigneeUserId !== u.id;
    if (
      (toOther || target.teamId !== undefined) &&
      !can(u.role, "helpdesk.manage")
    )
      await requireActionPermission("helpdesk.manage");
    await assignTicket(
      z.uuid().parse(id),
      target,
      { id: u.id, type: "user" },
      version,
    );
    revalidate(id);
    return undefined;
  });
}

export async function addMessageAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ messageId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const raw = formToObject(fd) as Record<string, unknown>;
    const input = ticketMessageSchema.parse({
      ...raw,
      to: csv(fd.get("to")),
      cc: csv(fd.get("cc")),
      bcc: csv(fd.get("bcc")),
    });
    const messageId = await addMessage(z.uuid().parse(id), input, {
      id: u.id,
      type: "user",
      name: u.name,
      email: u.email,
    });
    revalidate(id);
    return { messageId };
  });
}

export async function saveDraftAction(
  id: string,
  draft: {
    kind: "public" | "internal";
    body: string;
    ticketVersion?: number | null;
  },
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await saveDraft(z.uuid().parse(id), u.id, draft);
    return undefined;
  });
}

export async function addParticipantAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await addParticipant(
      z.uuid().parse(id),
      participantSchema.parse(formToObject(fd)),
      { id: u.id, type: "user" },
    );
    revalidate(id);
    return undefined;
  });
}
export async function removeParticipantAction(
  id: string,
  participantId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await removeParticipant(z.uuid().parse(id), z.uuid().parse(participantId), {
      id: u.id,
      type: "user",
    });
    revalidate(id);
    return undefined;
  });
}
export async function followTicketAction(
  id: string,
  follow: boolean,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.read");
    await toggleFollower(z.uuid().parse(id), u.id, follow);
    revalidate(id);
    return undefined;
  });
}

export async function linkTicketAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = ticketLinkSchema.parse(formToObject(fd));
    await linkTickets(z.uuid().parse(id), input.reference, input.kind, {
      id: u.id,
      type: "user",
    });
    revalidate(id);
    return undefined;
  });
}
export async function unlinkTicketAction(
  id: string,
  linkId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await unlinkTickets(z.uuid().parse(linkId), { id: u.id, type: "user" });
    revalidate(id);
    return undefined;
  });
}

export async function addTimeEntryAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = timeEntrySchema.parse({
      ...formToObject(fd),
      billable: fd.get("billable") !== "false",
    });
    await addTimeEntry(z.uuid().parse(id), u.id, input, {
      id: u.id,
      type: "user",
    });
    revalidate(id);
    return undefined;
  });
}
export async function deleteTimeEntryAction(
  id: string,
  entryId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await deleteTimeEntry(z.uuid().parse(entryId), {
      id: u.id,
      type: "user",
      canManage: can(u.role, "helpdesk.manage"),
    });
    revalidate(id);
    return undefined;
  });
}
export async function timerAction(
  id: string,
  op: "start" | "stop",
  note?: string,
): Promise<ActionResult<{ minutes: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const tid = z.uuid().parse(id);
    if (op === "start") {
      await startTimer(tid, u.id);
      revalidate(id);
      return { minutes: 0 };
    }
    const r = await stopTimer(tid, u.id, note?.trim() || null, {
      id: u.id,
      type: "user",
    });
    revalidate(id);
    return r;
  });
}

export async function bulkTicketAction(input: {
  ids: string[];
  action: "assign" | "team" | "priority" | "status";
  value: string;
}): Promise<ActionResult<{ done: number; errors: string[] }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    const parsed = bulkActionSchema.parse(input);
    const r = await bulkUpdate(parsed.ids, parsed.action, parsed.value, {
      id: u.id,
      type: "user",
    });
    revalidate();
    return r;
  });
}

export async function mergePreviewAction(
  sourceIds: string[],
  targetRef: string,
): Promise<ActionResult<Awaited<ReturnType<typeof mergePreview>>>> {
  return runAction(async () => {
    await requireActionPermission("helpdesk.manage");
    const { findTicketByReference } = await import("@/services/helpdesk");
    const target = await findTicketByReference(targetRef, false);
    if (!target)
      throw new (await import("@/lib/action-result")).ActionError(
        "No ticket with that reference.",
      );
    return mergePreview(z.array(z.uuid()).parse(sourceIds), target.id);
  });
}
export async function mergeTicketsAction(
  sourceIds: string[],
  targetId: string,
): Promise<ActionResult<{ targetId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    await mergeTickets(
      z.array(z.uuid()).parse(sourceIds),
      z.uuid().parse(targetId),
      { id: u.id, type: "user" },
    );
    revalidate();
    return { targetId };
  });
}
export async function splitTicketAction(
  id: string,
  input: { messageIds: string[]; subject: string },
): Promise<ActionResult<{ newTicketId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    const parsed = splitSchema.parse(input);
    const newTicketId = await splitTicket(
      z.uuid().parse(id),
      parsed.messageIds,
      parsed.subject,
      { id: u.id, type: "user" },
    );
    revalidate(id);
    return { newTicketId };
  });
}

export async function saveTeamAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = teamSchema.parse({
      ...formToObject(fd),
      memberIds: fd.getAll("memberIds").map(String),
      active: fd.get("active") !== "false",
    });
    const teamId = await saveTeam(id ? z.uuid().parse(id) : null, input, u.id);
    revalidate();
    return { id: teamId };
  });
}
export async function deleteTeamAction(
  id: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteTeam(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}
export async function saveCategoryAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = categorySchema.parse({
      ...formToObject(fd),
      active: fd.get("active") !== "false",
    });
    const cid = await saveCategory(id ? z.uuid().parse(id) : null, input, u.id);
    revalidate();
    return { id: cid };
  });
}
export async function deleteCategoryAction(
  id: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteCategory(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}
