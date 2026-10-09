import Link from "next/link";
import { requirePortalAccount } from "@/lib/portal-auth";
import { portalKbList } from "@/services/portal";
import { NewRequestForm } from "./form";

export const metadata = { title: "New request" };

export default async function NewRequestPage() {
  const account = await requirePortalAccount("/portal/tickets/new");
  const articles = (await portalKbList()).slice(0, 6);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <h1 className="text-xl font-semibold text-slate-900">New support request</h1>
        <p className="mb-4 text-sm text-slate-500">Tell us what is wrong or what you need. We will confirm by e-mail to {account.email} and keep the conversation here.</p>
        <NewRequestForm />
      </div>
      {articles.length > 0 && (
        <aside className="rounded-lg border border-slate-200 bg-surface p-4">
          <h2 className="text-sm font-semibold text-slate-800">Might solve it faster</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {articles.map((a) => (
              <li key={a.id}>
                <Link href={`/portal/kb/${a.slug}`} className="text-brand-700 hover:underline">{a.title}</Link>
                {a.excerpt && <p className="text-xs text-slate-500">{a.excerpt}</p>}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
