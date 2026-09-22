import { Construction } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui/page";

export function PlaceholderPage({ title, phase, description }: { title: string; phase: number; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={<Construction className="h-6 w-6" />} title={`${title} is built in Phase ${phase}`} description={description} />
    </>
  );
}
