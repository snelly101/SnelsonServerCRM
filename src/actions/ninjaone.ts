"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { connectNinjaOne, importAllOrganizations, importOrganizationAsCompany, linkLocation, linkOrganization, reviewDiscrepancy, runDiscrepancyCheck, saveNinjaConfig, syncNinjaOne, testNinjaOne, unlinkLocation, unlinkOrganization } from "@/services/ninjaone";

const revalidate = () => {
  revalidatePath("/integrations", "layout");
  revalidatePath("/devices", "layout");
  revalidatePath("/companies", "layout");
  revalidatePath("/contracts", "layout");
};

export async function connectNinjaOneAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ organisationCount: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const input = z.object({ clientId: z.string().trim().min(4).max(200), clientSecret: z.string().trim().min(8).max(500), region: z.enum(["us", "us2", "eu", "ca", "oc"]) }).parse({ clientId: fd.get("clientId"), clientSecret: fd.get("clientSecret"), region: fd.get("region") });
    const t = await connectNinjaOne(input, u.id);
    revalidate();
    return { organisationCount: t.ok ? t.organisationCount : 0 };
  });
}

export async function testNinjaOneAction(): Promise<ActionResult<{ ok: boolean; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const t = await testNinjaOne(u.id);
    revalidate();
    return { ok: t.ok, message: t.ok ? `Connected to ${t.instance} (${t.organisationCount}+ organisations)` : t.error };
  });
}

export async function syncNinjaOneAction(): Promise<ActionResult<{ status: string; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    const res = await syncNinjaOne("manual", u.id);
    revalidate();
    if (!res) return { status: "skipped", message: "NinjaOne is not configured." };
    return { status: res.status, message: res.status === "failed" ? (res.message ?? "Sync failed") : `${res.counters.fetched} devices checked, ${res.counters.created} new, ${res.counters.updated} updated${res.counters.errors ? `, ${res.counters.errors} errors` : ""}` };
  });
}

export async function linkOrganizationAction(orgId: string, companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await linkOrganization(z.string().min(1).parse(orgId), z.uuid().parse(companyId), u.id);
    revalidate();
    return undefined;
  });
}

export async function unlinkOrganizationAction(companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await unlinkOrganization(z.uuid().parse(companyId), u.id);
    revalidate();
    return undefined;
  });
}

export async function linkLocationAction(locationId: string, siteId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await linkLocation(z.string().min(1).parse(locationId), z.uuid().parse(siteId), u.id);
    revalidate();
    return undefined;
  });
}

export async function unlinkLocationAction(siteId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await unlinkLocation(z.uuid().parse(siteId), u.id);
    revalidate();
    return undefined;
  });
}

export async function saveNinjaConfigAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const classes = fd.getAll("billableNodeClasses[]").map(String).filter(Boolean);
    await saveNinjaConfig({ billableNodeClasses: z.array(z.string().max(60)).min(1, "Choose at least one device class").parse(classes), approvedOnly: fd.get("approvedOnly") === "true" }, u.id);
    revalidate();
    return undefined;
  });
}

export async function reviewDiscrepancyAction(id: string, status: "accepted" | "dismissed", note: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("discrepancy.review");
    await reviewDiscrepancy(z.uuid().parse(id), status, z.string().trim().max(500).parse(note) || null, u.id);
    revalidate();
    return undefined;
  });
}

export async function recheckDiscrepanciesAction(): Promise<ActionResult<{ open: number; resolved: number; checked: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("discrepancy.review");
    const r = await runDiscrepancyCheck(u.id);
    revalidate();
    return r;
  });
}

export async function importOrganizationAction(orgId: string): Promise<ActionResult<{ action: string; companyId?: string; reason?: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const r = await importOrganizationAsCompany(z.string().min(1).parse(orgId), u.id);
    revalidate();
    return { action: r.action, companyId: r.companyId, reason: r.reason };
  });
}

export async function importAllOrganizationsAction(): Promise<ActionResult<{ created: number; linked: number; skipped: { name: string; reason?: string }[] }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const r = await importAllOrganizations(u.id);
    revalidate();
    return { created: r.created, linked: r.linked, skipped: r.skipped.map((s) => ({ name: s.name, reason: s.reason })) };
  });
}
