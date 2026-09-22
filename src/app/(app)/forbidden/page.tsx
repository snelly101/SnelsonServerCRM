import { ShieldAlert } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page";

export default function ForbiddenPage() {
  return (
    <EmptyState
      icon={<ShieldAlert className="h-6 w-6" />}
      title="You don't have access to that page"
      description="Your role doesn't include this permission. Ask an administrator if you think you need it."
      action={<ButtonLink href="/">Back to dashboard</ButtonLink>}
    />
  );
}
