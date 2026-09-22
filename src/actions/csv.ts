"use server";

import { revalidatePath } from "next/cache";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult, ActionError } from "@/lib/action-result";
import { importCompaniesCsv, importContactsCsv, type ImportSummary } from "@/services/csv";

async function readFile(fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) throw new ActionError("Choose a CSV file to import.", { file: ["Required"] });
  if (file.size > 5_000_000) throw new ActionError("The file is larger than 5 MB.");
  return file.text();
}

export async function importCompaniesAction(_prev: ActionResult<ImportSummary> | null, fd: FormData): Promise<ActionResult<ImportSummary>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.import");
    const summary = await importCompaniesCsv(await readFile(fd), u.id);
    revalidatePath("/companies");
    return summary;
  });
}

export async function importContactsAction(_prev: ActionResult<ImportSummary> | null, fd: FormData): Promise<ActionResult<ImportSummary>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.import");
    const summary = await importContactsCsv(await readFile(fd), u.id);
    revalidatePath("/contacts");
    return summary;
  });
}
