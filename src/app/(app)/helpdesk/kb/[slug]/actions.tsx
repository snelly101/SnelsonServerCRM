"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  deleteArticleAction,
  restoreRevisionAction,
  setArticleStatusAction,
} from "@/actions/helpdesk-kb";

export function ArticleActions({
  id,
  status,
  canManage,
  canDelete,
  restoreVersion,
}: {
  id: string;
  status: "draft" | "published" | "archived";
  canManage: boolean;
  canDelete: boolean;
  restoreVersion?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  if (restoreVersion !== undefined)
    return (
      <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => restoreRevisionAction(id, restoreVersion))}>
        Restore
      </Button>
    );
  return (
    <>
      {error && <span className="text-xs text-red-700">{error}</span>}
      {canManage && status !== "published" && (
        <Button size="sm" loading={pending} onClick={() => run(() => setArticleStatusAction(id, "published"))}>
          Publish
        </Button>
      )}
      {canManage && status === "published" && (
        <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => setArticleStatusAction(id, "draft"))}>
          Unpublish
        </Button>
      )}
      {canManage && status !== "archived" && (
        <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => setArticleStatusAction(id, "archived"))}>
          Archive
        </Button>
      )}
      {canDelete && (
        <ConfirmButton
          size="sm"
          variant="ghost"
          action={async () => {
            const r = await deleteArticleAction(id);
            if (r.ok) router.push("/helpdesk/kb");
            return r;
          }}
          title="Delete this article?"
          description="Its history and ticket links are deleted too. Archive it instead to keep it out of the way."
          confirmLabel="Delete"
        >
          Delete
        </ConfirmButton>
      )}
    </>
  );
}
