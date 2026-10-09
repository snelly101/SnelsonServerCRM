"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { setServiceLineAction } from "@/actions/coverage";

export type LineOption = { id: string; description: string; contractName: string; contractStatus: string };

/** Chooses the contract line that bills a supplied service. Saves on change and re-runs the count check. */
export function ServiceLineSelect({ source, rowId, value, lines, canEdit, compact = false }: { source: string; rowId: string; value: string | null; lines: LineOption[]; canEdit: boolean; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();
  if (!canEdit) {
    const l = lines.find((x) => x.id === value);
    return <span className="text-xs text-slate-600">{l ? `${l.description} · ${l.contractName}` : "—"}</span>;
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <Select
        aria-label="Billed on contract line"
        value={value ?? ""}
        disabled={pending}
        className={compact ? "h-7 w-full min-w-[14rem] max-w-[20rem] py-0.5 text-xs leading-tight" : "w-auto max-w-xs"}
        onChange={(e) =>
          start(async () => {
            const r = await setServiceLineAction(source, rowId, e.target.value || null);
            if (!r.ok) return setError(r.error);
            setError(null);
            toast(e.target.value ? "Service charged on that line; counts re-checked" : "Link cleared");
            router.refresh();
          })
        }
      >
        <option value="">— not charged on a line —</option>
        {lines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.description}
            {l.contractStatus === "draft" ? " (draft)" : ""} · {l.contractName}
          </option>
        ))}
      </Select>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
