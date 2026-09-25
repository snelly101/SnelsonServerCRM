"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import { saveCategoryAction, saveTeamAction } from "@/actions/helpdesk";

type Team = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  members: { userId: string; isLead: boolean }[];
};
type Category = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  active: boolean;
};

export function TeamDialog({
  team,
  users,
}: {
  team?: Team;
  users: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(
    saveTeamAction.bind(null, team?.id ?? null),
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const members = new Set(team?.members.map((m) => m.userId) ?? []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant={team ? "ghost" : "primary"}
        onClick={() => setOpen(true)}
      >
        {team ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> New team
          </>
        )}
      </Button>
      <DialogContent title={team ? `Edit ${team.name}` : "New team"}>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <Field
            label="Name"
            htmlFor="tm-name"
            required
            error={fieldErrors(result, "name")}
          >
            <Input
              id="tm-name"
              name="name"
              defaultValue={team?.name ?? ""}
              required
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="tm-desc">
            <Input
              id="tm-desc"
              name="description"
              defaultValue={team?.description ?? ""}
            />
          </Field>
          <Field label="Lead" htmlFor="tm-lead">
            <Select
              id="tm-lead"
              name="leadUserId"
              defaultValue={team?.members.find((m) => m.isLead)?.userId ?? ""}
            >
              <option value="">—</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset>
            <legend className="field-label">Members</legend>
            <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-slate-200 p-2">
              {users.map((u) => (
                <Checkbox
                  key={u.id}
                  name="memberIds"
                  value={u.id}
                  defaultChecked={members.has(u.id)}
                  label={u.name}
                />
              ))}
            </div>
          </fieldset>
          <Checkbox
            name="active"
            value="true"
            defaultChecked={team?.active ?? true}
            label="Active (appears in assignment lists)"
          />
          <input type="hidden" name="active" value="false" />
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CategoryDialog({
  category,
  parents,
  parentId,
}: {
  category?: Category;
  parents: { id: string; name: string }[];
  parentId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(
    saveCategoryAction.bind(null, category?.id ?? null),
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const sub = Boolean(parentId ?? category?.parentId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant={category ? "ghost" : parentId ? "ghost" : "primary"}
        onClick={() => setOpen(true)}
      >
        {category ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" />{" "}
            {parentId ? "Subcategory" : "New category"}
          </>
        )}
      </Button>
      <DialogContent
        title={
          category
            ? `Edit ${category.name}`
            : sub
              ? "New subcategory"
              : "New category"
        }
      >
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <Field
            label="Name"
            htmlFor="ct-name"
            required
            error={fieldErrors(result, "name")}
          >
            <Input
              id="ct-name"
              name="name"
              defaultValue={category?.name ?? ""}
              required
              autoFocus
            />
          </Field>
          <Field label="Parent" htmlFor="ct-parent">
            <Select
              id="ct-parent"
              name="parentId"
              defaultValue={parentId ?? category?.parentId ?? ""}
            >
              <option value="">— top level —</option>
              {parents
                .filter((p) => p.id !== category?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Sort order" htmlFor="ct-sort">
            <Input
              id="ct-sort"
              name="sortOrder"
              type="number"
              min={0}
              defaultValue={category?.sortOrder ?? 0}
              className="w-24"
            />
          </Field>
          <Checkbox
            name="active"
            value="true"
            defaultChecked={category?.active ?? true}
            label="Active"
          />
          <input type="hidden" name="active" value="false" />
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
