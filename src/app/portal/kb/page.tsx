import Link from "next/link";
import { requirePortalAccount } from "@/lib/portal-auth";
import { portalKbCategories, portalKbList } from "@/services/portal";
import { Input } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Help articles" };

export default async function PortalKbPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  await requirePortalAccount("/portal/kb");
  const sp = await searchParams;
  const [articles, categories] = await Promise.all([portalKbList({ q: sp.q ?? null, category: sp.category ?? null }), portalKbCategories()]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Help articles</h1>
        <p className="text-sm text-slate-500">How-tos and answers to common questions. Search, or pick a category.</p>
      </div>
      <form className="flex flex-wrap items-center gap-2" method="get">
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search articles" aria-label="Search" className="w-72" />
        <button type="submit" className="rounded-md border border-slate-300 bg-surface px-3 py-2 text-sm hover:bg-slate-50">Search</button>
        {categories.length > 0 && (
          <span className="flex flex-wrap gap-1">
            <Link href="/portal/kb" className="rounded-full px-2 py-0.5 text-xs hover:bg-slate-100">All</Link>
            {categories.map((c) => (
              <Link key={c.category} href={`/portal/kb?category=${encodeURIComponent(c.category)}`} className={`rounded-full px-2 py-0.5 text-xs ${sp.category === c.category ? "bg-brand-50 text-brand-700" : "hover:bg-slate-100"}`}>{c.category} ({c.n})</Link>
            ))}
          </span>
        )}
      </form>
      {articles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-surface px-6 py-10 text-center text-sm text-slate-500">No articles match.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-surface">
          {articles.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <Link href={`/portal/kb/${a.slug}`} className="text-sm font-medium text-brand-700 hover:underline">{a.title}</Link>
              {a.category && <Badge className="ml-2">{a.category}</Badge>}
              {a.excerpt && <p className="text-xs text-slate-500">{a.excerpt}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
