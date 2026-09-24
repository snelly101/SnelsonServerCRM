"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, ActionError, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import {
  automationRuleSchema,
  businessHoursSchema,
  slaPolicySchema,
  templateSchema,
} from "@/lib/validation-helpdesk";
import type { WeeklySchedule } from "@/lib/helpdesk/business-hours";
import {
  deleteBusinessHours,
  deleteSlaPolicy,
  saveBusinessHours,
  saveSlaPolicy,
} from "@/services/helpdesk-sla";
import { deleteRule, saveRule } from "@/services/helpdesk-automation";
import { deleteTemplate, saveTemplate } from "@/services/helpdesk-collab";

const revalidate = () => {
  revalidatePath("/helpdesk", "layout");
};
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** "09:00-17:30, 18:00-20:00" → windows; blank = closed. */
function parseDay(s: string) {
  const out: { start: string; end: string }[] = [];
  for (const part of s.split(/[,;]/)) {
    const m = part.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!part.trim()) continue;
    if (!m) throw new ActionError(`Use HH:MM-HH:MM for each window (got "${part.trim()}").`);
    const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
    const start = pad(m[1]);
    const end = pad(m[2]);
    if (start >= end) throw new ActionError(`Window "${part.trim()}" ends before it starts.`);
    out.push({ start, end });
  }
  return out;
}

export async function saveBusinessHoursAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = businessHoursSchema.parse({
      ...formToObject(fd),
      always: fd.get("always") === "true",
      days: DAYS.map((d) => String(fd.get(`day_${d}`) ?? "")),
    });
    const schedule = Object.fromEntries(
      DAYS.map((d, i) => [d, parseDay(input.days[i])]),
    ) as WeeklySchedule;
    const bhId = await saveBusinessHours(
      id ? z.uuid().parse(id) : null,
      {
        name: input.name,
        timezone: input.timezone,
        schedule,
        holidays: [...new Set(input.holidays)].sort(),
        always: input.always,
      },
      u.id,
    );
    revalidate();
    return { id: bhId };
  });
}
export async function deleteBusinessHoursAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteBusinessHours(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}

export async function saveSlaPolicyAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = slaPolicySchema.parse({
      ...formToObject(fd),
      isDefault: fd.get("isDefault") === "true",
      active: fd.get("active") !== "false",
      pauseStatuses: fd.getAll("pauseStatuses").map(String),
      companyIds: fd.getAll("companyIds").map(String).filter(Boolean),
    });
    const pid = await saveSlaPolicy(
      id ? z.uuid().parse(id) : null,
      {
        name: input.name,
        description: input.description,
        businessHoursId: input.businessHoursId,
        firstResponseMinutes: {
          low: input.fr_low,
          normal: input.fr_normal,
          high: input.fr_high,
          critical: input.fr_critical,
        },
        resolutionMinutes: {
          low: input.res_low,
          normal: input.res_normal,
          high: input.res_high,
          critical: input.res_critical,
        },
        pauseStatuses: input.pauseStatuses,
        isDefault: input.isDefault,
        active: input.active,
        companyIds: input.companyIds,
      },
      u.id,
    );
    revalidate();
    return { id: pid };
  });
}
export async function deleteSlaPolicyAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteSlaPolicy(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}

export async function saveRuleAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = automationRuleSchema.parse({
      ...formToObject(fd),
      stopProcessing: fd.get("stopProcessing") === "true",
      active: fd.get("active") !== "false",
    });
    const rid = await saveRule(
      id ? z.uuid().parse(id) : null,
      {
        name: input.name,
        description: input.description,
        trigger: input.trigger,
        match: input.match,
        conditions: input.conditions,
        actions: input.actions,
        sortOrder: input.sortOrder,
        stopProcessing: input.stopProcessing,
        cooldownMinutes: input.cooldownMinutes,
        afterMinutes: input.afterMinutes,
        active: input.active,
      },
      u.id,
    );
    revalidate();
    return { id: rid };
  });
}
export async function deleteRuleAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteRule(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}

export async function saveTemplateAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    const input = templateSchema.parse({
      ...formToObject(fd),
      active: fd.get("active") !== "false",
    });
    const tid = await saveTemplate(id ? z.uuid().parse(id) : null, input, u.id);
    revalidate();
    return { id: tid };
  });
}
export async function deleteTemplateAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    await deleteTemplate(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}
