import { redirect } from "next/navigation";
import { currentPortalAccount } from "@/lib/portal-auth";
import { getAppSettings } from "@/lib/settings";
import { LoginRequestForm } from "./form";

export const metadata = { title: "Sign in" };

export default async function PortalLoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const sp = await searchParams;
  if (await currentPortalAccount()) redirect("/portal");
  const settings = await getAppSettings();
  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-lg border border-slate-200 bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Sign in to {settings.companyName} support</h1>
        <p className="mb-5 text-sm text-slate-500">Enter the e-mail address we hold for you and we will send a one-time sign-in link. No password needed.</p>
        <LoginRequestForm initialError={sp.error} />
      </div>
      <p className="mt-4 text-center text-xs text-slate-500">Not set up yet? Ask your IT provider to give you portal access.</p>
    </div>
  );
}
