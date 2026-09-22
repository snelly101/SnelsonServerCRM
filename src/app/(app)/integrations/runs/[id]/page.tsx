import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { syncRuns } from "@/db/schema";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { listSyncErrors, PROVIDER_LABELS, type Provider } from "@/services/integrations";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/format";

export default async function SyncRunPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integration.read");
  const { id } = await params;
  const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
  if (!run) notFound();
  const [errors, settings] = await Promise.all([listSyncErrors(id), getAppSettings()]);
  return (
    <>
      <PageHeader breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "Sync run" }]} title={`${PROVIDER_LABELS[run.provider as Provider]} · ${run.kind}`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Run">
          <DescriptionList
            items={[
              { label: "Status", value: <Badge tone={run.status === "success" ? "green" : run.status === "partial" ? "amber" : "red"}>{run.status}</Badge> },
              { label: "Started", value: fmtDateTime(run.startedAt, settings) },
              { label: "Finished", value: fmtDateTime(run.finishedAt, settings) },
              { label: "Trigger", value: run.trigger },
              { label: "Fetched / new / updated", value: `${run.fetched} / ${run.created} / ${run.updated}` },
              { label: "Message", value: run.message },
            ]}
          />
        </Card>
        <Card title={`Errors (${errors.length})`} padded={false} className="lg:col-span-2">
          {errors.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No errors recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="text-slate-800">{e.message}</div>
                  <div className="text-xs text-slate-500">
                    {e.externalId ? `external ${e.externalId}` : ""}
                    {e.localId ? ` · local ${e.localId}` : ""} · {fmtDateTime(e.at, settings)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
