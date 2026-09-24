import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { kbCategories, kbStats, listArticles, type KbStatus } from "@/services/helpdesk-kb";
import { PageHeader, Card, Stat } from "@/components/ui/page";
import { ButtonLink, Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { fmtRelative } from "@/lib/format";
import { param } from "@/lib/utils";

export const metadata = { title: "Knowledge base" };

export default async function KbPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("helpdesk.read");
  const sp = await searchParams;
  const q = param(sp, "q") ?? "";
  const status = (param(sp, "status") ?? "") as KbStatus | "all" | "";
  const category = param(sp, "category") ?? "";
  const [articles, categories, stats, settings] = await Promise.all([
    listArticles({ q, status: status || null, category: category || null }),
    kbCategories(),
    kbStats(),
    getAppSettings(),
  ]);
  void settings;
  const canEdit = can(me.role, "helpdesk.agent");
  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="How-to and fix articles for the team. Published articles are suggested on tickets by subject and can be inserted into notes; customer-visible ones can be sent in replies."
        actions={canEdit ? <ButtonLink href="/helpdesk/kb/new">New article</ButtonLink> : undefined}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Published" value={stats.published} />
        <Stat label="Customer-visible" value={stats.customerVisible} />
        <Stat label="Drafts" value={stats.drafts} tone={stats.drafts ? "warn" : "default"} />
        <Stat label="Review overdue" value={stats.reviewDue} tone={stats.reviewDue ? "danger" : "default"} />
      </div>
      <form className="mb-4 flex flex-wrap items-end gap-2" aria-label="Article filters">
        <Input name="q" defaultValue={q} placeholder="Search title, summary, tags and text" aria-label="Search articles" className="w-72" />
        <Select name="status" defaultValue={status} aria-label="Status" className="w-auto">
          <option value="">Active (draft + published)</option>
          <option value="published">Published</option>
          <option value="draft">Drafts</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
        <Select name="category" defaultValue={category} aria-label="Category" className="w-auto">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.n})
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="secondary">
          Filter
        </Button>
      </form>
      <Card padded={false}>
        {articles.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            {q || status || category ? "No articles match." : "No articles yet. Write the first one from a ticket you have just fixed."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {articles.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/helpdesk/kb/${a.slug}`} className="font-medium text-slate-900 hover:text-brand-700">
                    {a.title}
                  </Link>
                  {a.status !== "published" && <Badge tone={a.status === "draft" ? "amber" : "slate"}>{a.status}</Badge>}
                  {a.customerVisible && <Badge tone="green">customer-visible</Badge>}
                  {a.category && <span className="text-xs text-slate-500">{a.category}</span>}
                  {a.reviewDueAt && a.reviewDueAt < new Date() && a.status === "published" && (
                    <Badge tone="red">review overdue</Badge>
                  )}
                  <span className="ml-auto text-xs text-slate-400">
                    v{a.version} · {a.updatedByName ?? "—"} · {fmtRelative(a.updatedAt)} · used {a.usedCount}×
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{a.excerpt}</p>
                {a.tags.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {a.tags.map((t) => (
                      <Badge key={t} tone="slate">
                        {t}
                      </Badge>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
