import { requirePendingPortalSession } from "@/lib/portal-auth";
import { getAppSettings } from "@/lib/settings";
import { SetupForm } from "./form";

export const metadata = { title: "Set up your authenticator" };

export default async function PortalSetupPage() {
  const pending = await requirePendingPortalSession();
  const settings = await getAppSettings();
  return (
    <div className="mx-auto max-w-lg">
      <div className="rounded-lg border border-slate-200 bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">One more step, {pending.name.split(" ")[0]}</h1>
        <p className="mb-5 text-sm text-slate-500">
          The {settings.companyName} support portal uses a second check at sign-in: a 6-digit code from an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, 1Password and similar). Set it up once now.
        </p>
        <SetupForm email={pending.email} alreadyEnrolled={pending.enrolled} />
      </div>
    </div>
  );
}
