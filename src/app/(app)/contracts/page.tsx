import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Contracts & Services" };

export default async function Page() {
  await requirePermission("contract.read");
  return <PlaceholderPage title="Contracts & Services" phase={2} description="Managed service agreements, service catalogue, renewals and account reviews." />;
}
