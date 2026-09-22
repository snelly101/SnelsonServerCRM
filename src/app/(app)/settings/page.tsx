import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { Card } from "@/components/ui/page";
import { GeneralSettingsForm } from "./general-form";

export const metadata = { title: "Settings" };

export default async function GeneralSettingsPage() {
  const me = await requirePermission("settings.read");
  const settings = await getAppSettings();
  return (
    <Card title="General" className="max-w-2xl">
      <GeneralSettingsForm settings={{ ...settings, defaultTaxRatePercent: Number(settings.defaultTaxRatePercent) }} readOnly={!can(me.role, "settings.write")} />
    </Card>
  );
}
