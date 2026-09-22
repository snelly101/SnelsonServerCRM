import { requirePermission } from "@/lib/session";
import { listStages } from "@/services/opportunities";
import { Card } from "@/components/ui/page";
import { StageEditor } from "./stage-editor";

export const metadata = { title: "Pipeline stages" };

export default async function PipelineSettingsPage() {
  await requirePermission("settings.write");
  const stages = await listStages();
  return (
    <Card title="Pipeline stages" className="max-w-3xl">
      <p className="mb-4 text-sm text-slate-600">Reorder with the arrows. Each stage sets the default probability applied when an opportunity moves into it. Won and Lost are fixed.</p>
      <StageEditor stages={stages} />
    </Card>
  );
}
