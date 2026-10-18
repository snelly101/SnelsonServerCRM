import { LoginForm } from "./login-form";
import { isMicrosoftSsoEnabled } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings";
import { initials } from "@/lib/utils";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const settings = await getAppSettings();
  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="card card-rise w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-500 text-[13px] font-bold text-white">{initials(settings.companyName)}</span>
          <div>
            <h1 className="text-[17px] font-semibold leading-5 text-slate-900">{settings.companyName}</h1>
            <p className="text-[13px] text-slate-500">Sign in with your staff account.</p>
          </div>
        </div>
        <LoginForm next={sp.next?.startsWith("/") ? sp.next : "/"} microsoft={isMicrosoftSsoEnabled} initialError={sp.error} />
      </div>
    </div>
  );
}
