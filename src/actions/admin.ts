"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  appSettingsSchema,
  customFieldDefSchema,
  formToObject,
  savedViewSchema,
  tagSchema,
  userCreateSchema,
  userUpdateSchema,
} from "@/lib/validation";
import { createUser, updateUser } from "@/services/users";
import {
  createCustomFieldDef,
  createSavedView,
  createTag,
  deleteCustomFieldDef,
  deleteSavedView,
  deleteTag,
  updateAppSettings,
} from "@/services/settings";

export async function createUserAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("user.manage");
    const input = userCreateSchema.parse(formToObject(fd));
    await createUser(input, u.id);
    revalidatePath("/settings/users");
    return undefined;
  });
}

export async function updateUserAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("user.manage");
    const obj = formToObject(fd);
    const input = userUpdateSchema.parse({ ...obj, active: obj.active === "true" });
    await updateUser({ ...input, password: input.password || null }, u.id);
    revalidatePath("/settings/users");
    return undefined;
  });
}

export async function updateSettingsAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    const input = appSettingsSchema.parse(formToObject(fd));
    await updateAppSettings(input, u.id);
    revalidatePath("/", "layout");
    return undefined;
  });
}

export async function createTagAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await createTag(tagSchema.parse(formToObject(fd)), u.id);
    revalidatePath("/settings/fields");
    return undefined;
  });
}

export async function deleteTagAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await deleteTag(z.uuid().parse(id), u.id);
    revalidatePath("/settings/fields");
    return undefined;
  });
}

export async function createCustomFieldAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    const obj = formToObject(fd);
    const options = String(obj.options ?? "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    await createCustomFieldDef(customFieldDefSchema.parse({ ...obj, options }), u.id);
    revalidatePath("/settings/fields");
    return undefined;
  });
}

export async function deleteCustomFieldAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await deleteCustomFieldDef(z.uuid().parse(id), u.id);
    revalidatePath("/settings/fields");
    return undefined;
  });
}

export async function saveViewAction(input: { page: string; name: string; params: Record<string, string>; isShared?: boolean }): Promise<ActionResult<string>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.read");
    const id = await createSavedView(savedViewSchema.parse(input), u.id);
    revalidatePath(`/${input.page}`);
    return id;
  });
}

export async function deleteViewAction(id: string, page: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.read");
    await deleteSavedView(z.uuid().parse(id), u.id);
    revalidatePath(`/${page}`);
    return undefined;
  });
}
