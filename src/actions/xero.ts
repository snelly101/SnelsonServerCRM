"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { ActionError, runAction, type ActionResult } from "@/lib/action-result";
import { approveAndCreateInvoice, cancelInvoiceDraft, createXeroContactForCompany, importAllRepeatingInvoices, importRepeatingInvoiceAsContract, importAllXeroCustomers, importXeroContactAsCompany, linkCompanyToXeroContact, prepareInvoiceDraft, previewContractInvoice, pushContactDetailsToXero, reprepareInvoiceDraft, selectXeroTenant, syncXero, testXero, updateInvoiceDraft } from "@/services/xero";
import { approveUnchangedDrafts, type BatchApprovalResult } from "@/services/draft-review";
import { getAppSettings } from "@/lib/settings";
import { removeLink, getLink } from "@/services/integrations";
import type { InvoiceDraftLine } from "@/db/schema";

const revalidateXero = () => {
  revalidatePath("/integrations", "layout");
  revalidatePath("/billing", "layout");
  revalidatePath("/companies", "layout");
};

export async function selectTenantAction(tenantId: string): Promise<ActionResult<{ organisationName: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const t = await selectXeroTenant(z.string().min(1).parse(tenantId), u.id);
    revalidateXero();
    return { organisationName: t.ok ? t.organisationName : "" };
  });
}

export async function testXeroAction(): Promise<ActionResult<{ ok: boolean; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const t = await testXero(u.id);
    revalidateXero();
    return { ok: t.ok, message: t.ok ? `Connected to ${t.organisationName}` : t.error };
  });
}

export async function syncXeroAction(full = false): Promise<ActionResult<{ status: string; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    const res = await syncXero("manual", u.id, { full });
    revalidateXero();
    if (!res) return { status: "skipped", message: "Xero is not configured." };
    return { status: res.status, message: res.status === "failed" ? (res.message ?? "Sync failed") : `Checked ${res.counters.fetched}, ${res.counters.created} new, ${res.counters.updated} updated${res.counters.errors ? `, ${res.counters.errors} errors` : ""}` };
  });
}

export async function linkXeroContactAction(companyId: string, contactId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await linkCompanyToXeroContact(z.uuid().parse(companyId), z.string().min(1).parse(contactId), u.id);
    revalidateXero();
    return undefined;
  });
}

export async function unlinkXeroContactAction(companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const link = await getLink("xero", "company", z.uuid().parse(companyId));
    if (link) await removeLink(link.id, u.id);
    revalidateXero();
    return undefined;
  });
}

export async function createXeroContactAction(companyId: string): Promise<ActionResult<{ contactId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const contactId = await createXeroContactForCompany(z.uuid().parse(companyId), u.id);
    revalidateXero();
    return { contactId };
  });
}

export async function pushContactToXeroAction(companyId: string): Promise<ActionResult<{ changed: boolean }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const r = await pushContactDetailsToXero(z.uuid().parse(companyId), u.id);
    revalidateXero();
    return r;
  });
}

/** Drafts the chosen one-off / hardware lines of a contract, dated as asked; each line can be invoiced once. */
export async function prepareOneOffInvoiceAction(input: { contractId: string; lineIds: string[]; invoiceDate?: string }): Promise<ActionResult<{ draftId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const p = z.object({ contractId: z.uuid(), lineIds: z.array(z.uuid()).min(1, "Tick at least one line"), invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse({ ...input, invoiceDate: input.invoiceDate || undefined });
    const { contractWithLines } = await import("@/services/billing-coverage");
    const found = await contractWithLines(p.contractId);
    if (!found) throw new ActionError("Contract not found.");
    const draftId = await prepareInvoiceDraft({ companyId: found.contract.companyId, contractId: p.contractId, oneOffLineIds: p.lineIds, invoiceDate: p.invoiceDate }, u.id);
    revalidateXero();
    revalidatePath(`/contracts/${p.contractId}`);
    return { draftId };
  });
}

/** An ad hoc draft for a customer: typed lines, an invoice date and a reference of the person's choosing. */
export async function prepareAdHocInvoiceAction(input: { companyId: string; invoiceDate?: string; reference?: string; lines: { description: string; quantity: number; unitAmount: number; hardware?: boolean }[] }): Promise<ActionResult<{ draftId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const p = z
      .object({
        companyId: z.uuid(),
        invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reference: z.string().trim().max(120).optional(),
        lines: z.array(z.object({ description: z.string().trim().min(1, "Every line needs a description").max(300), quantity: z.coerce.number().min(0).max(1_000_000), unitAmount: z.coerce.number().min(-1_000_000).max(1_000_000), hardware: z.boolean().optional() })).min(1, "Add at least one line").max(50),
      })
      .parse({ ...input, invoiceDate: input.invoiceDate || undefined, reference: input.reference || undefined });
    const draftId = await prepareInvoiceDraft({ companyId: p.companyId, adHoc: { reference: p.reference ?? null, lines: p.lines }, invoiceDate: p.invoiceDate }, u.id);
    revalidateXero();
    revalidatePath(`/companies/${p.companyId}`);
    return { draftId };
  });
}

export async function prepareInvoiceAction(input: { companyId: string; contractId?: string; opportunityId?: string; periodStart?: string; periodEnd?: string; invoiceDate?: string }): Promise<ActionResult<{ draftId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const parsed = z.object({ companyId: z.uuid(), contractId: z.uuid().optional(), opportunityId: z.uuid().optional(), periodStart: z.string().optional(), periodEnd: z.string().optional(), invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse({ ...input, invoiceDate: input.invoiceDate || undefined });
    const draftId = await prepareInvoiceDraft(parsed, u.id);
    revalidateXero();
    return { draftId };
  });
}

const lineSchema = z.object({ description: z.string().trim().min(1).max(500), quantity: z.coerce.number().min(0), unitAmount: z.coerce.number(), accountCode: z.string().trim().min(1).max(20), taxType: z.string().trim().min(1).max(40), itemCode: z.string().trim().max(50).optional().nullable() });

export async function updateDraftAction(id: string, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const lines: InvoiceDraftLine[] = [];
    const raw = JSON.parse(String(fd.get("lines") ?? "[]")) as unknown[];
    for (const l of raw) lines.push(lineSchema.parse(l));
    await updateInvoiceDraft(z.uuid().parse(id), { invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("invoiceDate")), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("dueDate")), description: String(fd.get("description") ?? "") || null, notes: String(fd.get("notes") ?? "") || null, lines }, u.id);
    revalidateXero();
    return undefined;
  });
}

export async function previewInvoiceAction(input: { contractId: string; periodStart: string; periodEnd: string }): Promise<ActionResult<Awaited<ReturnType<typeof previewContractInvoice>>>> {
  return runAction(async () => {
    await requireActionPermission("invoice.prepare");
    const p = z.object({ contractId: z.uuid(), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(input);
    if (p.periodEnd < p.periodStart) throw new ActionError("The period end is before its start.");
    return previewContractInvoice(p.contractId, p.periodStart, p.periodEnd);
  });
}

export async function reprepareDraftAction(id: string): Promise<ActionResult<{ draftId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const draftId = await reprepareInvoiceDraft(z.uuid().parse(id), u.id);
    revalidateXero();
    return { draftId };
  });
}

export async function approveInvoiceAction(id: string): Promise<ActionResult<{ invoiceId: string; reused: boolean }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.approve");
    const r = await approveAndCreateInvoice(z.uuid().parse(id), u.id);
    revalidateXero();
    return r;
  });
}

export async function cancelDraftAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    await cancelInvoiceDraft(z.uuid().parse(id), u.id);
    revalidateXero();
    return undefined;
  });
}

export async function importXeroContactAction(contactId: string, linkExistingId?: string | null): Promise<ActionResult<{ action: string; companyId?: string; reason?: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const r = await importXeroContactAsCompany(z.string().min(1).parse(contactId), u.id, { linkExistingId: linkExistingId ? z.uuid().parse(linkExistingId) : null });
    revalidateXero();
    return { action: r.action, companyId: r.companyId, reason: r.reason };
  });
}

export async function importAllXeroCustomersAction(): Promise<ActionResult<{ created: number; linked: number; skipped: { name: string; reason?: string }[] }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const r = await importAllXeroCustomers(u.id);
    revalidateXero();
    return { created: r.created, linked: r.linked, skipped: r.skipped.map((s) => ({ name: s.name, reason: s.reason })) };
  });
}

export async function importRepeatingInvoiceAction(templateId: string): Promise<ActionResult<{ action: string; contractId?: string; reason?: string; productsCreated?: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const r = await importRepeatingInvoiceAsContract(z.string().min(1).parse(templateId), u.id);
    revalidateXero();
    revalidatePath("/contracts", "layout");
    return { action: r.action, contractId: r.contractId, reason: r.reason, productsCreated: r.productsCreated };
  });
}

export async function importAllRepeatingInvoicesAction(): Promise<ActionResult<{ created: number; productsCreated: number; skipped: { reference: string | null; reason?: string }[] }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const r = await importAllRepeatingInvoices(u.id);
    revalidateXero();
    revalidatePath("/contracts", "layout");
    return { created: r.created, productsCreated: r.productsCreated, skipped: r.skipped.map((s) => ({ reference: s.reference, reason: s.reason })) };
  });
}

export async function approveUnchangedDraftsAction(ids: string[]): Promise<ActionResult<BatchApprovalResult>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.approve");
    const parsed = z.array(z.uuid()).min(1).max(200).parse(ids);
    const settings = await getAppSettings();
    const r = await approveUnchangedDrafts(parsed, u.id, settings.currency);
    revalidateXero();
    return r;
  });
}
