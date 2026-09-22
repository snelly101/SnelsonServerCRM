import { Field, Input, Select, Checkbox } from "@/components/ui/form";

export type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select";
  options: string[] | null;
  required: boolean;
};

export function CustomFieldsInputs({ defs, values, errors }: { defs: CustomFieldDef[]; values: Record<string, unknown>; errors?: Record<string, string[]> }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {defs.map((d) => {
        const name = `cf_${d.key}`;
        const v = values[d.key];
        const err = errors?.[`customFields.${d.key}`];
        if (d.type === "boolean") {
          return (
            <div key={d.id} className="flex items-end pb-2">
              <Checkbox name={name} label={d.label} defaultChecked={Boolean(v)} />
            </div>
          );
        }
        return (
          <Field key={d.id} label={d.label} htmlFor={name} required={d.required} error={err}>
            {d.type === "select" ? (
              <Select id={name} name={name} defaultValue={(v as string) ?? ""} required={d.required}>
                <option value="">—</option>
                {(d.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id={name} name={name} type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} step={d.type === "number" ? "any" : undefined} defaultValue={(v as string | number) ?? ""} required={d.required} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

export function CustomFieldsDisplay({ defs, values }: { defs: CustomFieldDef[]; values: Record<string, unknown> }) {
  const items = defs.filter((d) => values[d.key] !== undefined && values[d.key] !== "" && values[d.key] !== null);
  if (!items.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((d) => (
        <div key={d.id}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{d.label}</dt>
          <dd className="mt-0.5 text-sm text-slate-800">{d.type === "boolean" ? (values[d.key] ? "Yes" : "No") : String(values[d.key])}</dd>
        </div>
      ))}
    </dl>
  );
}
