"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import type { ActionResult } from "@/lib/action-result";
import type { ImportSummary } from "@/services/csv";

export function ImportForm({
  action,
  columns,
  sample,
  autoFocus,
}: {
  action: (prev: ActionResult<ImportSummary> | null, fd: FormData) => Promise<ActionResult<ImportSummary>>;
  columns: readonly string[];
  sample: string;
  autoFocus?: boolean;
}) {
  const [result, formAction] = useActionState(action, null);
  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-600">
        <p className="mb-1">Recognised columns (header row required, any order):</p>
        <div className="flex flex-wrap gap-1">
          {columns.map((c) => (
            <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
              {c}
            </code>
          ))}
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-brand-700">Show example</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{sample}</pre>
        </details>
      </div>
      <form action={formAction} className="space-y-3">
        <FormMessage result={result && !result.ok ? result : null} />
        <Field label="CSV file" htmlFor="file" required>
          <Input id="file" name="file" type="file" accept=".csv,text/csv" required autoFocus={autoFocus} />
        </Field>
        <SubmitButton>Import</SubmitButton>
      </form>
      {result?.ok && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="green">{result.data.created} created</Badge>
            <Badge tone="amber">{result.data.skipped} skipped</Badge>
            <Badge tone="red">{result.data.errors} errors</Badge>
          </div>
          {result.data.results.filter((r) => r.status !== "created").length > 0 && (
            <div className="max-h-64 overflow-auto rounded border border-slate-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Result</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.results
                    .filter((r) => r.status !== "created")
                    .map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>
                          <Badge tone={r.status === "error" ? "red" : "amber"}>{r.status}</Badge>
                        </td>
                        <td className="text-slate-600">{r.message}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
