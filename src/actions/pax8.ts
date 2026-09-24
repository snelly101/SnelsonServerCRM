"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  applyPax8Cost,
  connectPax8,
  linkPax8Company,
  runLicenceCheck,
  savePax8Config,
  setSubscriptionBillingLine,
  syncPax8,
  testPax8,
  unlinkPax8Company,
} from "@/services/pax8";

const revalidate = () => {
  revalidatePath("/integrations", "layout");
  revalidatePath("/companies", "layout");
  revalidatePath("/contracts", "layout");
};

export async function connectPax8Action(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ companyCount: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const input = z
      .object({
        clientId: z
          .string()
          .trim()
          .min(8, "That does not look like a Pax8 client id")
          .max(200),
        clientSecret: z.string().trim().min(8).max(500),
      })
      .parse({
        clientId: fd.get("clientId"),
        clientSecret: fd.get("clientSecret"),
      });
    const t = await connectPax8(input, u.id);
    revalidate();
    return { companyCount: t.ok ? t.companyCount : 0 };
  });
}

export async function testPax8Action(): Promise<
  ActionResult<{ ok: boolean; message: string }>
> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const t = await testPax8(u.id);
    revalidate();
    return {
      ok: t.ok,
      message: t.ok
        ? `Connected to Pax8 (${t.companyCount} companies)`
        : t.error,
    };
  });
}

export async function syncPax8Action(): Promise<
  ActionResult<{ status: string; message: string }>
> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    const res = await syncPax8("manual", u.id);
    revalidate();
    if (!res) return { status: "skipped", message: "Pax8 is not configured." };
    return {
      status: res.status,
      message:
        res.status === "failed"
          ? (res.message ?? "Sync failed")
          : `${res.counters.fetched} records checked, ${res.counters.created} new, ${res.counters.updated} updated${res.counters.errors ? `, ${res.counters.errors} errors` : ""}`,
    };
  });
}

export async function linkPax8CompanyAction(
  pax8CompanyRowId: string,
  companyId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await linkPax8Company(
      z.uuid().parse(pax8CompanyRowId),
      z.uuid().parse(companyId),
      u.id,
    );
    revalidate();
    return undefined;
  });
}

export async function unlinkPax8CompanyAction(
  pax8CompanyRowId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await unlinkPax8Company(z.uuid().parse(pax8CompanyRowId), u.id);
    revalidate();
    return undefined;
  });
}

export async function setSubscriptionBillingLineAction(
  subscriptionRowId: string,
  contractLineId: string | null,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await setSubscriptionBillingLine(
      z.uuid().parse(subscriptionRowId),
      contractLineId ? z.uuid().parse(contractLineId) : null,
      u.id,
    );
    revalidate();
    return undefined;
  });
}

export async function applyPax8CostAction(
  subscriptionRowId: string,
): Promise<ActionResult<{ unitCost: string; from: string | null }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const r = await applyPax8Cost(z.uuid().parse(subscriptionRowId), u.id);
    revalidate();
    return { unitCost: r.unitCost, from: r.from };
  });
}

export async function recheckLicencesAction(): Promise<
  ActionResult<{ open: number; resolved: number; checked: number }>
> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    const r = await runLicenceCheck(u.id);
    revalidate();
    return r;
  });
}

export async function savePax8ConfigAction(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const input = z
      .object({
        autoLink: z.boolean(),
        invoiceCount: z.coerce.number().int().min(0).max(24),
      })
      .parse({
        autoLink: fd.get("autoLink") === "true",
        invoiceCount: fd.get("invoiceCount"),
      });
    await savePax8Config(input, u.id);
    revalidate();
    return undefined;
  });
}
