import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getArticle, recordArticleView } from "@/services/helpdesk-kb";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/helpdesk/badges";
import { MarkdownLite } from "@/lib/markdown-lite";
import { fmtDateTime } from "@/lib/format";
import { ArticleActions } from "./actions";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await getArticle(slug);
  return { title: a ? a.title : "Article" };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const me = await requirePermission("helpdesk.read");
  const { slug } = await params;
  const a = await getArticle(slug);
  if (!a) notFound();
  await recordArticleView(a.id);
  const settings = await getAppSettings();
  const canEdit = can(me.role, "helpdesk.agent");
  const canManage = can(me.role, "helpdesk.manage");
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/helpdesk/kb" className="hover:text-slate-800">
          Knowledge base
        </Link>{" "}
        / {a.title}
      </nav>
      <PageHeader
        title={a.title}
        description={a.summary ?? undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <ButtonLink href={`/helpdesk/kb/${a.slug}/edit`} variant="secondary">
                Edit
              </ButtonLink>
            )}
            <ArticleActions id={a.id} status={a.status} canManage={canManage} canDelete={can(me.role, "helpdesk.admin")} />
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={a.status === "published" ? "green" : a.status === "draft" ? "amber" : "slate"}>{a.status}</Badge>
        {a.customerVisible ? <Badge tone="blue">customer-visible</Badge> : <Badge tone="slate">internal only</Badge>}
        {a.category && <span className="text-slate-500">{a.category}</span>}
        {a.tags.map((t) => (
          <Badge key={t} tone="slate">
            {t}
          </Badge>
        ))}
        {a.reviewDueAt && (
          <span className={a.reviewDueAt < new Date() ? "text-red-700" : "text-slate-500"}>
            review due {fmtDateTime(a.reviewDueAt, settings)}
          </span>
        )}
      </div>
      {a.status === "draft" && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Draft: not suggested on tickets and cannot be inserted into replies until a helpdesk manager publishes it.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <article className="prose-sm max-w-none text-sm" aria-label="Article body">
            <MarkdownLite text={a.body} />
          </article>
        </Card>
        <div className="space-y-4">
          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Version", value: a.version },
                { label: "Created", value: `${fmtDateTime(a.createdAt, settings)}${a.createdByName ? ` · ${a.createdByName}` : ""}` },
                { label: "Updated", value: `${fmtDateTime(a.updatedAt, settings)}${a.updatedByName ? ` · ${a.updatedByName}` : ""}` },
                { label: "Published", value: a.publishedAt ? fmtDateTime(a.publishedAt, settings) : "—" },
                { label: "Views / used", value: `${a.viewCount} / ${a.usedCount}` },
              ]}
            />
          </Card>
          <Card title="Linked tickets" padded={false}>
            {a.tickets.length === 0 ? (
              <p className="p-3 text-xs text-slate-500">Not linked to a ticket yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-xs">
                {a.tickets.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 px-3 py-1.5">
                    <Link href={`/helpdesk/tickets/${t.id}`} className="font-mono text-slate-500 hover:underline">
                      {t.reference}
                    </Link>
                    <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                    <StatusBadge status={t.status} />
                    <span className="text-slate-400">{t.kind === "sent" ? "sent" : t.kind === "created_from" ? "source" : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="History" padded={false}>
            <ul className="divide-y divide-slate-100 text-xs">
              {a.revisions.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="font-mono text-slate-500">v{r.version}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {fmtDateTime(r.at, settings)}
                    {r.editorName ? ` · ${r.editorName}` : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                  {canEdit && r.version !== a.version && (
                    <ArticleActions id={a.id} status={a.status} canManage={false} canDelete={false} restoreVersion={r.version} />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
