import { requirePermission } from "@/lib/session";

/** The helpdesk section pills are rendered by the app shell (see components/nav-config.ts). */
export default async function HelpdeskLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("helpdesk.read");
  return <>{children}</>;
}
