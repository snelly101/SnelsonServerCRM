"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import { contractLineSchema, contractSchema, linesFromForm } from "@/lib/validation-sales";
import { archiveContract, createContract, generateReminders, updateContract } from "@/services/contracts";

function readContractForm(fd: FormData) {
  const obj = formToObject(fd);
  const input = contractSchema.parse({ ...obj, autoRenew: obj.autoRenew === "true" });
  const lines = z.array(contractLineSchema).parse(linesFromForm(obj).map((l) => ({ ...l, countsAsManagedDevice: l.countsAsManagedDevice === "true" })));
  return { input, lines };
}

export async function createContractAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<string>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const { input, lines } = readContractForm(fd);
    const id = await createContract(input, lines, u.id);
    revalidatePath("/contracts");
    revalidatePath(`/companies/${input.companyId}`);
    return id;
  });
  if (res.ok) redirect(`/contracts/${res.data}`);
  return res;
}

export async function updateContractAction(id: string, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const { input, lines } = readContractForm(fd);
    await updateContract(z.uuid().parse(id), input, lines, u.id);
    revalidatePath("/contracts");
    revalidatePath(`/contracts/${id}`);
    return undefined;
  });
  if (res.ok) redirect(`/contracts/${id}`);
  return res;
}

export async function archiveContractAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await archiveContract(z.uuid().parse(id), u.id);
    revalidatePath("/contracts");
    return undefined;
  });
}

export async function runRemindersAction(): Promise<ActionResult<{ created: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const res = await generateReminders(u.id);
    revalidatePath("/tasks");
    revalidatePath("/contracts");
    return res;
  });
}
