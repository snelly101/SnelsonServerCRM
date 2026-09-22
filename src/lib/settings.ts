import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

export const getAppSettings = cache(async () => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!row) {
    const [created] = await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing().returning();
    return created ?? (await db.select().from(appSettings).where(eq(appSettings.id, 1)))[0];
  }
  return row;
});

export type AppSettings = Awaited<ReturnType<typeof getAppSettings>>;
