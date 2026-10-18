import { AlertTriangle, Info, XCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const styles = {
  info: { box: "bg-blue-50 text-blue-900", icon: "text-blue-500", Icon: Info },
  warn: { box: "bg-amber-50 text-amber-900", icon: "text-amber-500", Icon: AlertTriangle },
  error: { box: "bg-red-50 text-red-900", icon: "text-red-500", Icon: XCircle },
  success: { box: "bg-green-50 text-green-900", icon: "text-green-600", Icon: CheckCircle2 },
};

export function Alert({ tone = "info", title, children, className }: { tone?: keyof typeof styles; title?: string; children?: React.ReactNode; className?: string }) {
  const { box, icon, Icon } = styles[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-xl px-4 py-3 text-[13px]", box, className)} role={tone === "error" ? "alert" : "status"}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden />
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
    </div>
  );
}
