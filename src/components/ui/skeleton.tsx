import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

/** The soft placeholder shown while a page's data loads: a heading, a row of tiles and a card. */
export function PageSkeleton() {
  return (
    <div className="animate-fade" role="status" aria-label="Loading">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-3.5 w-80" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-64 rounded-xl" />
    </div>
  );
}
