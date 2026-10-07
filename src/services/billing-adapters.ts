import { pax8BillingAdapter } from "@/connectors/pax8/billing";
import { twentyIBillingAdapter } from "@/connectors/twentyi/billing";
import { ninjaOneBillingAdapter } from "@/connectors/ninjaone/billing";
import type { BillingAdapter, ProviderKey, ServiceSource } from "@/lib/billing-model";

/** Every integration that supplies services to customers, in the order they are shown. Add a new provider here and nowhere else. */
export const BILLING_ADAPTERS: BillingAdapter[] = [pax8BillingAdapter, twentyIBillingAdapter, ninjaOneBillingAdapter];

export const adapterFor = (provider: ProviderKey) => BILLING_ADAPTERS.find((a) => a.provider === provider)!;

export const PROVIDER_OF_SOURCE: Record<ServiceSource, ProviderKey> = { pax8_subscription: "pax8", hosting_item: "twentyi", ninja_device: "ninjaone" };
