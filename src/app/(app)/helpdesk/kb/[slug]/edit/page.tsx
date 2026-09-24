import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getArticle } from "@/services/helpdesk-kb";
import { PageHeader, Card } from "@/components/ui/page";
import { ArticleForm } from "../../article-form";

export const metadata = { title: "Edit article" };

export default async function EditArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const me = await requirePermission("helpdesk.agent");
  const { slug } = await params;
  const a = await getArticle(slug);
  if (!a) notFound();
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/helpdesk/kb" className="hover:text-slate-800">
          Knowledge base
        </Link>{" "}
        /{" "}
        <Link href={`/helpdesk/kb/${a.slug}`} className="hover:text-slate-800">
          {a.title}
        </Link>{" "}
        / Edit
      </nav>
      <PageHeader title={`Edit: ${a.title}`} description={`Version ${a.version}. Content changes create a new version; earlier versions can be restored.`} />
      <Card>
        <ArticleForm
          article={{
            id: a.id,
            title: a.title,
            body: a.body,
            summary: a.summary,
            category: a.category,
            tags: a.tags,
            customerVisible: a.customerVisible,
            reviewDueAt: a.reviewDueAt,
          }}
          canManage={can(me.role, "helpdesk.manage")}
        />
      </Card>
    </>
  );
}
