import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/page";
import { SettingsNav } from "./nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const me = await requirePermission("settings.read");
  const items = [
    { href: "/settings", label: "General" },
    { href: "/settings/fields", label: "Tags & custom fields" },
    ...(can(me.role, "settings.write") ? [{ href: "/settings/pipeline", label: "Pipeline stages" }] : []),
    ...(can(me.role, "user.manage") ? [{ href: "/settings/users", label: "Users & roles" }] : []),
    ...(can(me.role, "audit.read") ? [{ href: "/settings/audit", label: "Audit log" }] : []),
    ...(can(me.role, "vault.admin") ? [{ href: "/settings/vault", label: "Secure Vault" }] : []),
  ];
  void Link;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <SettingsNav items={items} />
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
