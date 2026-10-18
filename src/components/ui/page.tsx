import Link from "next/link";
import { ChevronRight, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-6">
      {breadcrumbs && (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-slate-500">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
              {b.href ? (
                <Link href={b.href} className="hover:text-slate-800">
                  {b.label}
                </Link>
              ) : (
                <span className="text-slate-700">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-slate-900">{title}</h1>
          {description && <p className="mt-1.5 max-w-3xl text-[13px] text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * The standard white surface. A title row is compact and sits inside the
 * card; a divider appears only when the body is unpadded (lists, tables),
 * so a titled card of prose reads as one block.
 */
export function Card({ title, description, actions, children, className, padded = true }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn("card card-rise", className)}>
      {(title || actions) && (
        <header className={cn("flex items-start justify-between gap-3 px-5 pt-4", padded ? "pb-1" : "border-b border-slate-100 pb-3")}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold leading-6 text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? (title || actions ? "px-5 pb-5 pt-3" : "p-5") : ""}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-surface p-3 text-slate-400 shadow-lift">{icon ?? <Inbox className="h-5 w-5" aria-hidden />}</div>
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-[13px] text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const STAT_TONE = {
  default: "text-slate-900",
  warn: "text-amber-700",
  danger: "text-red-700",
  good: "text-green-700",
} as const;

/** A stand-alone metric card: small label, large tight number, muted hint, optional icon in the corner. */
export function Stat({ label, value, hint, tone = "default", icon, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: keyof typeof STAT_TONE; icon?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("card card-rise p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] font-medium text-slate-500">{label}</div>
        {icon && <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-50 text-slate-500 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      </div>
      <div className={cn("mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums", STAT_TONE[tone])}>{value}</div>
      {hint && <div className="mt-2 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

/** A compact metric tile for use inside a card grid (muted surface, smaller number). */
export function MiniStat({ label, value, hint, tone = "default", icon, accent }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: keyof typeof STAT_TONE; icon?: React.ReactNode; /** Render as the orange highlight tile. */ accent?: boolean }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg p-4", accent ? "feature-gradient text-white" : "bg-slate-50")}>
      <div className="flex items-start justify-between gap-2">
        <div className={cn("text-xs font-medium", accent ? "text-white/80" : "text-slate-500")}>{label}</div>
        {icon && <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full [&>svg]:h-3 [&>svg]:w-3", accent ? "bg-white/20 text-white" : "bg-surface text-slate-500 shadow-lift")}>{icon}</span>}
      </div>
      <div className={cn("mt-2 text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums", accent ? "text-white" : STAT_TONE[tone])}>{value}</div>
      {hint && <div className={cn("mt-2 text-[11px]", accent ? "text-white/80" : "text-slate-500")}>{hint}</div>}
    </div>
  );
}

/**
 * The orange feature card: an eyebrow pill, a large number with a unit, an
 * optional progress bar with hatched remainder, and a white pill action with
 * a muted note beside it.
 */
export function FeatureCard({
  eyebrow,
  meta,
  value,
  unit,
  progress,
  facts,
  action,
  note,
  className,
}: {
  eyebrow?: React.ReactNode;
  meta?: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  progress?: { value: number; max: number; left?: React.ReactNode; right?: React.ReactNode };
  /** Small supporting figures shown in a row beneath the progress bar. */
  facts?: { label: React.ReactNode; value: React.ReactNode }[];
  action?: React.ReactNode;
  note?: React.ReactNode;
  className?: string;
}) {
  const pct = progress ? Math.max(0, Math.min(100, progress.max > 0 ? (progress.value / progress.max) * 100 : 0)) : 0;
  return (
    <section className={cn("feature-gradient card-rise relative flex flex-col overflow-hidden rounded-xl p-5 text-white", className)}>
      <div className="flex items-center justify-between gap-3">
        {eyebrow ? <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-xs font-medium backdrop-blur-sm [&>svg]:h-3.5 [&>svg]:w-3.5">{eyebrow}</span> : <span />}
        {meta && <span className="text-xs text-white/80">{meta}</span>}
      </div>
      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{value}</span>
        {unit && <span className="text-sm font-medium text-white/85">{unit}</span>}
      </div>
      {progress && (
        <div className="mt-4">
          <div className="relative h-2 overflow-hidden rounded-full bg-white/15">
            <div className="hatch absolute inset-0 rounded-full opacity-70" />
            <div className="relative h-full rounded-full bg-white transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
          </div>
          {(progress.left || progress.right) && (
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/80">
              <span>{progress.left}</span>
              <span>{progress.right}</span>
            </div>
          )}
        </div>
      )}
      {facts && facts.length > 0 && (
        <dl className="mt-5 grid grid-cols-3 gap-3">
          {facts.map((f, i) => (
            <div key={i} className="rounded-lg bg-white/12 px-3 py-2 backdrop-blur-sm">
              <dt className="text-[11px] text-white/75">{f.label}</dt>
              <dd className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-[-0.01em]">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(action || note) && (
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
          {action}
          {note && <span className="text-xs text-white/80">{note}</span>}
        </div>
      )}
    </section>
  );
}

export function DescriptionList({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-slate-500">{it.label}</dt>
          <dd className="mt-0.5 break-words text-[13px] text-slate-800">{it.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
