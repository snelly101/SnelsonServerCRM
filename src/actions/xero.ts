"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { approveAndCreateInvoice, cancelInvoiceDraft, createXeroContactForCompany, importAllRepeatingInvoices, importRepeatingInvoiceAsContract, importAllXeroCustomers, importXeroContactAsCompany, linkCompanyToXeroContact, prepareInvoiceDraft, pushContactDetailsToXero, selectXeroTenant, syncXero, testXero, updateInvoiceDraft } from "@/services/xero";
import { removeLink, getLink } from "@/services/integrations";
import type { InvoiceDraftLine } from "@/db/schema";

const revalidateXero = () => {
  revalidatePath("/integrations", "layout");
  revalidatePath("/finance", "layout");
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

export async function prepareInvoiceAction(input: { companyId: string; contractId?: string; opportunityId?: string; periodStart?: string; periodEnd?: string }): Promise<ActionResult<{ draftId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const parsed = z.object({ companyId: z.uuid(), contractId: z.uuid().optional(), opportunityId: z.uuid().optional(), periodStart: z.string().optional(), periodEnd: z.string().optional() }).parse(input);
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
