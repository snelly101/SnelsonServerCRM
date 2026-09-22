import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Sales Pipeline" };

export default async function Page() {
  await requirePermission("opportunity.read");
  return <PlaceholderPage title="Sales Pipeline" phase={2} description="Configurable stages, drag-and-drop board and table view, weighted forecast." />;
}
