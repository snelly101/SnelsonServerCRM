import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Proposals" };

export default async function Page() {
  await requirePermission("proposal.read");
  return <PlaceholderPage title="Proposals" phase={3} description="Better Proposals linking, creation from templates, and acceptance tracking." />;
}
