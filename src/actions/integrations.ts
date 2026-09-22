"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { connectBetterProposals, createProposalForOpportunity, linkProposalToCompany, linkProposalToOpportunity, syncProposals, testBetterProposals } from "@/services/proposals";
import { disconnect, resolveConflict, setConnectionConfig, removeLink, type Provider } from "@/services/integrations";

const providerSchema = z.enum(["betterproposals", "xero", "ninjaone"]);

export async function connectBetterProposalsAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ accountName: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const token = z.string().trim().min(10, "Paste the API token from Better Proposals").max(500).parse(fd.get("apiToken"));
    const res = await connectBetterProposals(token, u.id);
    revalidatePath("/integrations", "layout");
    return { accountName: res.ok ? res.accountName : "" };
  });
}

export async function testConnectionAction(provider: Provider): Promise<ActionResult<{ ok: boolean; message: string; mode: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    providerSchema.parse(provider);
    if (provider === "betterproposals") {
      const t = await testBetterProposals(u.id);
      revalidatePath("/integrations", "layout");
      return { ok: t.ok, message: t.ok ? `Connected as ${t.accountName}` : t.error, mode: t.mode };
    }
    return { ok: false, message: `${provider} arrives in a later phase.`, mode: "none" };
  });
}

export async function disconnectAction(provider: Provider): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await disconnect(providerSchema.parse(provider), u.id);
    revalidatePath("/integrations", "layout");
    return undefined;
  });
}

export async function saveIntegrationConfigAction(provider: Provider, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    providerSchema.parse(provider);
    const config: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) if (!k.startsWith("$") && typeof v === "string") config[k] = v;
    await setConnectionConfig(provider, config, u.id);
    revalidatePath("/integrations", "layout");
    return undefined;
  });
}

export async function syncNowAction(provider: Provider): Promise<ActionResult<{ status: string; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    providerSchema.parse(provider);
    if (provider === "betterproposals") {
      const res = await syncProposals("manual", u.id);
      revalidatePath("/integrations", "layout");
      revalidatePath("/proposals");
      revalidatePath("/pipeline", "layout");
      if (!res) return { status: "skipped", message: "Better Proposals is not configured." };
      return { status: res.status, message: res.status === "failed" ? (res.message ?? "Sync failed") : `Checked ${res.counters.fetched}, ${res.counters.created} new, ${res.counters.updated} updated${res.counters.errors ? `, ${res.counters.errors} errors` : ""}` };
    }
    return { status: "skipped", message: `${provider} arrives in a later phase.` };
  });
}

export async function resolveConflictAction(id: string, status: "resolved" | "dismissed"): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await resolveConflict(z.uuid().parse(id), status, u.id);
    revalidatePath("/integrations", "layout");
    return undefined;
  });
}

export async function unlinkAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await removeLink(z.uuid().parse(id), u.id);
    revalidatePath("/integrations", "layout");
    return undefined;
  });
}

export async function createProposalAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ externalId: string; viewUrl: string | null; reused: boolean; mode: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("proposal.create");
    const opportunityId = z.uuid().parse(fd.get("opportunityId"));
    const templateId = String(fd.get("templateId") ?? "") || undefined;
    const contactIds = fd.getAll("contactIds[]").map(String).filter(Boolean);
    const mergeTags: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("mt_") && typeof v === "string") mergeTags[k.slice(3)] = v.trim();
    const version = Number(fd.get("version") ?? 1) || 1;
    const res = await createProposalForOpportunity({ opportunityId, templateId, contactIds, mergeTags, version }, u.id);
    revalidatePath(`/pipeline/${opportunityId}`);
    revalidatePath("/proposals");
    return res;
  });
}

export async function linkProposalAction(externalId: string, target: { opportunityId?: string; companyId?: string }): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("proposal.create");
    z.string().min(1).parse(externalId);
    if (target.opportunityId) await linkProposalToOpportunity(externalId, z.uuid().parse(target.opportunityId), u.id);
    else if (target.companyId) await linkProposalToCompany(externalId, z.uuid().parse(target.companyId), u.id);
    revalidatePath("/proposals");
    revalidatePath("/pipeline", "layout");
    revalidatePath("/integrations", "layout");
    return undefined;
  });
}
