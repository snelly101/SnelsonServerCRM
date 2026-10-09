import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePortalAccount } from "@/lib/portal-auth";
import { portalKbArticle } from "@/services/portal";
import { getAppSettings } from "@/lib/settings";
import { fmtDate } from "@/lib/format";
import { MarkdownLite } from "@/lib/markdown-lite";
import { Badge } from "@/components/ui/badge";

export default async function PortalKbArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requirePortalAccount(`/portal/kb/${slug}`);
  const [a, settings] = await Promise.all([portalKbArticle(slug), getAppSettings()]);
  if (!a) notFound();
  return (
    <article className="space-y-4">
      <Link href="/portal/kb" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:underline"><ArrowLeft className="h-4 w-4" /> All articles</Link>
      <div className="rounded-lg border border-slate-200 bg-surface p-6">
        <h1 className="text-xl font-semibold text-slate-900">{a.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {a.category && <Badge>{a.category}</Badge>}
          <span>Updated {fmtDate(a.updatedAt, settings)}</span>
        </div>
        {a.summary && <p className="mt-3 text-sm text-slate-600">{a.summary}</p>}
        <div className="mt-4"><MarkdownLite text={a.body} className="space-y-3 text-sm leading-relaxed text-slate-800" /></div>
      </div>
      <p className="text-sm text-slate-500">Did not help? <Link href="/portal/tickets/new" className="text-brand-700 hover:underline">Raise a request</Link>.</p>
    </article>
  );
}
