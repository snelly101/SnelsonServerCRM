import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { audit, diffFields } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import type { ProductInput } from "@/lib/validation-sales";

export async function listProducts(opts?: { includeInactive?: boolean }) {
  const rows = await db.select().from(products).orderBy(asc(products.category), asc(products.sortOrder), asc(products.name));
  return opts?.includeInactive ? rows : rows.filter((p) => p.active);
}

export async function getProduct(id: string) {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return row ?? null;
}

function toRow(input: ProductInput) {
  return {
    sku: input.sku,
    name: input.name,
    category: input.category,
    description: input.description,
    pricingModel: input.pricingModel,
    revenueType: input.revenueType,
    billingFrequency: input.revenueType === "recurring" ? input.billingFrequency : ("one_off" as const),
    unitPrice: String(input.unitPrice),
    unitCost: input.unitCost === null ? null : String(input.unitCost),
    countsAsManagedDevice: input.pricingModel === "per_device" && input.countsAsManagedDevice,
    active: input.active,
  };
}

export async function createProduct(input: ProductInput, actorUserId: string) {
  const [row] = await db.insert(products).values(toRow(input)).onConflictDoNothing().returning({ id: products.id });
  if (!row) throw new ActionError("A product with that SKU already exists.", { sku: ["Already in use"] });
  await audit({ actorUserId, action: "product.create", entityType: "product", entityId: row.id, details: { name: input.name } });
  return row.id;
}

export async function updateProduct(id: string, input: ProductInput, actorUserId: string) {
  const before = await getProduct(id);
  if (!before) throw new ActionError("Product not found.");
  const next = toRow(input);
  await db.update(products).set({ ...next, updatedAt: new Date() }).where(eq(products.id, id));
  await audit({ actorUserId, action: "product.update", entityType: "product", entityId: id, details: { changes: diffFields(before as unknown as Record<string, unknown>, next) } });
}
