import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Finance" };

export default async function Page() {
  await requirePermission("finance.read");
  return <PlaceholderPage title="Finance" phase={4} description="Xero invoices, payments and customer financial summaries." />;
}
