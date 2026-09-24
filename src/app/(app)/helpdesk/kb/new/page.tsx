import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getTicket } from "@/services/helpdesk";
import { PageHeader, Card } from "@/components/ui/page";
import { param } from "@/lib/utils";
import { markdownToPlainText } from "@/lib/markdown-parse";
import { ArticleForm } from "../article-form";

export const metadata = { title: "New article" };

export default async function NewArticlePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("helpdesk.agent");
  const sp = await searchParams;
  const ticketId = param(sp, "ticket") ?? null;
  const t = ticketId ? await getTicket(ticketId).catch(() => null) : null;
  // Writing an article from a ticket pre-fills the symptom (subject) and the resolution so nothing is retyped.
  const initialBody = t
    ? `## Symptoms\n\n${t.subject}\n\n## Fix\n\n${t.resolutionSummary ?? ""}\n\n## Notes\n\n${
        t.messages
          .filter((m) => m.kind === "internal")
          .slice(-2)
          .map((m) => markdownToPlainText(m.bodyMarkdown ?? m.bodyText ?? ""))
          .join("\n\n")
      }`.trim()
    : "";
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/helpdesk/kb" className="hover:text-slate-800">
          Knowledge base
        </Link>{" "}
        / New article
      </nav>
      <PageHeader
        title="New article"
        description={t ? `Written from ${t.reference}: the ticket will link to the article.` : "Articles start as drafts; a helpdesk manager publishes them."}
      />
      <Card>
        <ArticleForm canManage={can(me.role, "helpdesk.manage")} fromTicketId={t?.id ?? null} initialTitle={t?.subject} initialBody={initialBody} />
      </Card>
    </>
  );
}
