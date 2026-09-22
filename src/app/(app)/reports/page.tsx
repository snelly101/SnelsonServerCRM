import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Reports" };

export default async function Page() {
  await requirePermission("report.read");
  return <PlaceholderPage title="Reports" phase={6} description="Pipeline, MRR, renewals, overdue tasks, outstanding invoices, integration health." />;
}
