import { currentTwoFactorPolicy, requireUser } from "@/lib/session";
import { PageHeader } from "@/components/ui/page";
import { Alert } from "@/components/ui/alert";
import { SecurityPanel } from "./security-panel";

export const metadata = { title: "Security" };

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  // This page must stay reachable for users who are required to enrol.
  const me = await requireUser({ allowUnenrolled: true });
  const sp = await searchParams;
  const policy = (await currentTwoFactorPolicy())!;
  return (
    <>
      <PageHeader title="Security" description="Two-factor authentication for your own sign-in." />
      {policy.mustEnrol && (
        <Alert tone="warn" title="Two-factor authentication is required for your role" className="mb-4">
          Set up an authenticator app below to continue using the CRM.{sp.required ? "" : ""}
        </Alert>
      )}
      {policy.dueBy && !me.twoFactorEnabled && (
        <Alert tone="info" title={`Set up two-factor authentication by ${policy.dueBy}`} className="mb-4">
          After that date you will be asked to enrol before you can use the CRM.
        </Alert>
      )}
      <div className="max-w-2xl">
        <SecurityPanel enabled={me.twoFactorEnabled} hasPassword={me.hasPassword} required={policy.required} email={me.email} />
      </div>
    </>
  );
}
