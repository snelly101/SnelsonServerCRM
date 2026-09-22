import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Integrations" };

export default async function Page() {
  await requirePermission("integration.read");
  return <PlaceholderPage title="Integrations" phase={3} description="Connection status, mapping, manual sync, sync history and error recovery." />;
}
