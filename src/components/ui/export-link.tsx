import { Download } from "lucide-react";
import { buttonClass } from "./button";

/** Plain anchor so the browser downloads the CSV rather than client-routing to it. */
export function ExportLink({ href, label = "Export CSV" }: { href: string; label?: string }) {
  return (
    <a href={href} className={buttonClass("secondary")} download>
      <Download className="h-4 w-4" /> {label}
    </a>
  );
}
