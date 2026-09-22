import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Devices" };

export default async function Page() {
  await requirePermission("device.read");
  return <PlaceholderPage title="Devices" phase={5} description="NinjaOne organisations, locations and managed devices, with contract discrepancy checks." />;
}
