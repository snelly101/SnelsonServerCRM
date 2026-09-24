"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  Textarea,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import { saveRuleAction } from "@/actions/helpdesk-admin";
import {
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_LABELS,
  RULE_ACTION_LABELS,
  RULE_ACTION_TYPES,
  RULE_OPS,
  RULE_OP_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
} from "@/lib/validation-helpdesk";

type Condition = { field: string; op: (typeof RULE_OPS)[number]; value?: string | string[] | number | null };
type Action = { type: (typeof RULE_ACTION_TYPES)[number]; value?: string | string[] | null };
type Options = {
  agents: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  categories: { id: string; name: string }[];
};
export type RuleForm = {
  id: string;
  name: string;
  description: string | null;
  trigger: (typeof AUTOMATION_TRIGGERS)[number];
  match: "all" | "any";
  conditions: Condition[];
  actions: Action[];
  sortOrder: number;
  stopProcessing: boolean;
  cooldownMinutes: number;
  afterMinutes: number | null;
  active: boolean;
};

const FIELDS: { key: string; label: string; kind: "status" | "priority" | "type" | "source" | "category" | "team" | "agent" | "text" | "bool" | "number" }[] = [
  { key: "status", label: "Status", kind: "status" },
  { key: "priority", label: "Priority", kind: "priority" },
  { key: "type", label: "Type", kind: "type" },
  { key: "source", label: "Source", kind: "source" },
  { key: "categoryId", label: "Category", kind: "category" },
  { key: "teamId", label: "Team", kind: "team" },
  { key: "assigneeUserId", label: "Assignee", kind: "agent" },
  { key: "tags", label: "Tags", kind: "text" },
  { key: "subject", label: "Subject", kind: "text" },
  { key: "requesterEmail", label: "Requester e-mail", kind: "text" },
  { key: "requesterDomain", label: "Requester domain", kind: "text" },
  { key: "requesterUnverified", label: "Requester unverified", kind: "bool" },
  { key: "needsReview", label: "Needs review", kind: "bool" },
  { key: "hoursSinceActivity", label: "Hours since last activity", kind: "number" },
  { key: "hoursSinceCreated", label: "Hours since created", kind: "number" },
  { key: "hoursSinceResolved", label: "Hours since resolved", kind: "number" },
];

function ValueInput({
  kind,
  value,
  onChange,
  options,
  label,
}: {
  kind: (typeof FIELDS)[number]["kind"] | "none";
  value: string;
  onChange: (v: string) => void;
  options: Options;
  label: string;
}) {
  const sel = (items: { id: string; name: string }[]) => (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs">
      <option value="">choose…</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </Select>
  );
  switch (kind) {
    case "none":
      return null;
    case "status":
      return sel(TICKET_STATUSES.map((s) => ({ id: s, name: TICKET_STATUS_LABELS[s] })));
    case "priority":
      return sel(TICKET_PRIORITIES.map((s) => ({ id: s, name: TICKET_PRIORITY_LABELS[s] })));
    case "type":
      return sel(TICKET_TYPES.map((s) => ({ id: s, name: TICKET_TYPE_LABELS[s] })));
    case "source":
      return sel([
        { id: "email", name: "E-mail" },
        { id: "manual", name: "Manual" },
        { id: "portal", name: "Portal" },
      ]);
    case "category":
      return sel(options.categories);
    case "team":
      return sel(options.teams);
    case "agent":
      return sel(options.agents);
    case "bool":
      return sel([
        { id: "true", name: "yes" },
        { id: "false", name: "no" },
      ]);
    case "number":
      return <Input aria-label={label} type="number" step="0.5" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs" />;
    default:
      return <Input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs" placeholder="value (use | between several)" />;
  }
}

const actionKind = (t: Action["type"]): (typeof FIELDS)[number]["kind"] | "none" | "note" | "users" => {
  switch (t) {
    case "assign_user":
      return "agent";
    case "assign_team":
      return "team";
    case "set_priority":
      return "priority";
    case "set_status":
      return "status";
    case "set_category":
      return "category";
    case "set_type":
      return "type";
    case "add_tag":
    case "remove_tag":
      return "text";
    case "add_note":
      return "note";
    case "notify_users":
      return "users";
    default:
      return "none";
  }
};
const toStr = (v: Condition["value"] | Action["value"]) =>
  v === null || v === undefined ? "" : Array.isArray(v) ? v.join("|") : String(v);
const fromStr = (s: string, multi: boolean): string | string[] | null => {
  if (!s) return null;
  if (multi || s.includes("|")) return s.split("|").map((x) => x.trim()).filter(Boolean);
  return s;
};

export function RuleDialog({ rule, options }: { rule?: RuleForm; options: Options }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveRuleAction.bind(null, rule?.id ?? null), null);
  const [trigger, setTrigger] = useState<RuleForm["trigger"]>(rule?.trigger ?? "ticket_created");
  const [conditions, setConditions] = useState<Condition[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<Action[]>(rule?.actions ?? [{ type: "assign_team" }]);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const setCond = (i: number, patch: Partial<Condition>) =>
    setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setAct = (i: number, patch: Partial<Action>) =>
    setActions((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={rule ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {rule ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> New rule
          </>
        )}
      </Button>
      <DialogContent title={rule ? `Edit rule: ${rule.name}` : "New automation rule"} wide>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <input type="hidden" name="conditions" value={JSON.stringify(conditions)} />
          <input type="hidden" name="actions" value={JSON.stringify(actions)} />
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label="Name" htmlFor="rule-name" required error={fieldErrors(result, "name")}>
              <Input id="rule-name" name="name" defaultValue={rule?.name ?? ""} required />
            </Field>
            <Field label="Order" htmlFor="rule-order">
              <Input id="rule-order" name="sortOrder" type="number" min="0" defaultValue={rule?.sortOrder ?? 10} />
            </Field>
            <Field label="Cooldown (min)" htmlFor="rule-cooldown">
              <Input id="rule-cooldown" name="cooldownMinutes" type="number" min="0" defaultValue={rule?.cooldownMinutes ?? 60} />
            </Field>
          </div>
          <Field label="Description" htmlFor="rule-desc">
            <Input id="rule-desc" name="description" defaultValue={rule?.description ?? ""} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When" htmlFor="rule-trigger" required>
              <Select
                id="rule-trigger"
                name="trigger"
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as RuleForm["trigger"])}
              >
                {AUTOMATION_TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {AUTOMATION_TRIGGER_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            {trigger === "schedule" ? (
              <Field label="Only tickets idle for at least (minutes)" htmlFor="rule-after">
                <Input id="rule-after" name="afterMinutes" type="number" min="0" defaultValue={rule?.afterMinutes ?? 1440} />
              </Field>
            ) : (
              <input type="hidden" name="afterMinutes" value="" />
            )}
          </div>
          <fieldset className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium text-slate-600">
              If{" "}
              <select
                name="match"
                defaultValue={rule?.match ?? "all"}
                className="rounded border border-slate-300 bg-surface px-1 text-xs"
                aria-label="Match"
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>{" "}
              of these conditions match (none = always)
            </legend>
            <ul className="space-y-2">
              {conditions.map((c, i) => {
                const f = FIELDS.find((x) => x.key === c.field) ?? FIELDS[0];
                const noValue = c.op === "empty" || c.op === "not_empty";
                return (
                  <li key={i} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <Select aria-label="Condition field" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: null })} className="h-8 text-xs">
                      {FIELDS.map((x) => (
                        <option key={x.key} value={x.key}>
                          {x.label}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Condition operator" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition["op"] })} className="h-8 text-xs">
                      {RULE_OPS.map((op) => (
                        <option key={op} value={op}>
                          {RULE_OP_LABELS[op]}
                        </option>
                      ))}
                    </Select>
                    <div>
                      <ValueInput
                        kind={noValue ? "none" : f.kind}
                        value={toStr(c.value)}
                        onChange={(v) => setCond(i, { value: f.kind === "number" ? Number(v) : fromStr(v, c.op === "in") })}
                        options={options}
                        label="Condition value"
                      />
                    </div>
                    <button type="button" aria-label="Remove condition" className="text-slate-400 hover:text-red-700" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setConditions((cs) => [...cs, { field: "priority", op: "eq", value: null }])}>
              <Plus className="h-3.5 w-3.5" /> Add condition
            </Button>
          </fieldset>
          <fieldset className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium text-slate-600">Then</legend>
            {fieldErrors(result, "actions") && (
              <p className="mb-1 text-xs text-red-700">{fieldErrors(result, "actions")?.join(", ")}</p>
            )}
            <ul className="space-y-2">
              {actions.map((a, i) => {
                const kind = actionKind(a.type);
                return (
                  <li key={i} className="grid items-start gap-2 sm:grid-cols-[1fr_2fr_auto]">
                    <Select aria-label="Action" value={a.type} onChange={(e) => setAct(i, { type: e.target.value as Action["type"], value: null })} className="h-8 text-xs">
                      {RULE_ACTION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {RULE_ACTION_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                    <div>
                      {kind === "note" ? (
                        <Textarea aria-label="Note text" rows={2} value={toStr(a.value)} onChange={(e) => setAct(i, { value: e.target.value })} className="text-xs" placeholder="Internal note added to the ticket" />
                      ) : kind === "users" ? (
                        <select
                          aria-label="Users to notify"
                          multiple
                          size={4}
                          value={Array.isArray(a.value) ? a.value : a.value ? [a.value] : []}
                          onChange={(e) => setAct(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                          className="w-full rounded-md border border-slate-300 bg-surface p-1 text-xs"
                        >
                          {options.agents.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <ValueInput kind={kind} value={toStr(a.value)} onChange={(v) => setAct(i, { value: fromStr(v, false) })} options={options} label="Action value" />
                      )}
                    </div>
                    <button type="button" aria-label="Remove action" className="mt-1 text-slate-400 hover:text-red-700" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}>
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setActions((as) => [...as, { type: "add_tag" }])}>
              <Plus className="h-3.5 w-3.5" /> Add action
            </Button>
          </fieldset>
          <div className="flex flex-wrap gap-4">
            <Checkbox name="stopProcessing" value="true" label="Stop processing later rules when this one matches" defaultChecked={rule?.stopProcessing ?? false} />
            <Checkbox name="active" value="true" label="Active" defaultChecked={rule?.active ?? true} />
          </div>
          <input type="hidden" name="active" value="false" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save rule</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
