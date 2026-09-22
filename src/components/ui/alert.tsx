import { AlertTriangle, Info, XCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const styles = {
  info: { box: "border-blue-200 bg-blue-50 text-blue-900", Icon: Info },
  warn: { box: "border-amber-200 bg-amber-50 text-amber-900", Icon: AlertTriangle },
  error: { box: "border-red-200 bg-red-50 text-red-900", Icon: XCircle },
  success: { box: "border-green-200 bg-green-50 text-green-900", Icon: CheckCircle2 },
};

export function Alert({ tone = "info", title, children, className }: { tone?: keyof typeof styles; title?: string; children?: React.ReactNode; className?: string }) {
  const { box, Icon } = styles[tone];
  return (
    <div className={cn("flex gap-2 rounded-md border px-3 py-2 text-sm", box, className)} role={tone === "error" ? "alert" : "status"}>
      <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <div>
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
    </div>
  );
}
