import { LoginForm } from "./login-form";
import { isMicrosoftSsoEnabled } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const settings = await getAppSettings();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{settings.companyName} CRM</h1>
        <p className="mb-5 text-sm text-slate-500">Sign in with your staff account.</p>
        <LoginForm next={sp.next?.startsWith("/") ? sp.next : "/"} microsoft={isMicrosoftSsoEnabled} initialError={sp.error} />
      </div>
    </div>
  );
}
