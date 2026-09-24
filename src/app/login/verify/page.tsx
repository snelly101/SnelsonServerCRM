import { getAppSettings } from "@/lib/settings";
import { VerifyForm } from "./verify-form";

export const metadata = { title: "Verify it's you" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const settings = await getAppSettings();
  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{settings.companyName} CRM</h1>
        <p className="mb-5 text-sm text-slate-500">Enter the 6-digit code from your authenticator app.</p>
        <VerifyForm next={sp.next?.startsWith("/") ? sp.next : "/"} />
      </div>
    </div>
  );
}
