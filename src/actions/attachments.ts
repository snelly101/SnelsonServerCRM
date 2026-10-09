"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { deleteAttachment, updateAttachment } from "@/services/attachments";

const revalidate = (companyId: string) => revalidatePath(`/companies/${companyId}`, "page");

const patchSchema = z.object({
  caption: z.string().max(500).optional(),
  siteId: z.uuid().nullable().optional().or(z.literal("").transform(() => null)),
  fileName: z.string().trim().min(1, "Give the file a name").max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function updateAttachmentAction(id: string, input: z.input<typeof patchSchema>): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const companyId = await updateAttachment(u, z.uuid().parse(id), patchSchema.parse(input));
    revalidate(companyId);
    return undefined;
  });
}

export async function deleteAttachmentAction(id: string, restore = false): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const companyId = await deleteAttachment(u, z.uuid().parse(id), restore);
    revalidate(companyId);
    return undefined;
  });
}
