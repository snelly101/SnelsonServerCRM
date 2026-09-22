import { requirePermission } from "@/lib/session";
import { PlaceholderPage } from "../_placeholder";

export const metadata = { title: "Tasks & Onboarding" };

export default async function Page() {
  await requirePermission("task.read");
  return <PlaceholderPage title="Tasks & Onboarding" phase={2} description="Tasks with owners and due dates, reusable onboarding checklists." />;
}
