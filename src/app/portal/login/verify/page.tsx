import { redirect } from "next/navigation";
import { requirePendingPortalSession } from "@/lib/portal-auth";
import { VerifyForm } from "./form";

export const metadata = { title: "Enter your code" };

export default async function PortalVerifyPage() {
  const pending = await requirePendingPortalSession();
  if (!pending.enrolled) redirect("/portal/login/setup");
  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-lg border border-slate-200 bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Hello {pending.name.split(" ")[0]}, one more step</h1>
        <p className="mb-5 text-sm text-slate-500">Enter the 6-digit code from your authenticator app. If your phone is unavailable, use one of your recovery codes instead.</p>
        <VerifyForm />
      </div>
    </div>
  );
}
