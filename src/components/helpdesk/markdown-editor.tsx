"use client";

import { useRef, useState, type RefObject } from "react";
import { Bold, Heading2, Link2, List, Eye, Pencil } from "lucide-react";
import { Textarea } from "@/components/ui/form";
import { MarkdownLite } from "@/lib/markdown-lite";

/** Textarea with the CRM's Markdown toolbar and a preview toggle. Controlled: parent owns the value. */
export function MarkdownEditor({
  id,
  name,
  value,
  onChange,
  rows = 6,
  placeholder,
  disabled,
  textareaRef,
  onKeyDown,
}: {
  id: string;
  name?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const [preview, setPreview] = useState(false);
  const insert = (
    before: string,
    after = "",
    placeholderText = "text",
    linePrefix = false,
  ) => {
    const ta = ref.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end) || placeholderText;
    let next: string;
    let cursor: number;
    if (linePrefix) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      next = value.slice(0, lineStart) + before + value.slice(lineStart);
      cursor = end + before.length;
    } else {
      next =
        value.slice(0, start) + before + selected + after + value.slice(end);
      cursor = start + before.length + selected.length + after.length;
    }
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  };
  const tool = (label: string, Icon: typeof Bold, fn: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={fn}
      disabled={preview || disabled}
      className="rounded p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
  return (
    <div className="rounded-md border border-slate-300 bg-surface">
      <div className="flex items-center gap-0.5 border-b border-slate-200 px-1 py-0.5">
        {tool("Heading", Heading2, () => insert("## ", "", "", true))}
        {tool("Bold", Bold, () => insert("**", "**"))}
        {tool("Bullet list", List, () => insert("- ", "", "", true))}
        {tool("Link", Link2, () => insert("[", "](https://)", "link text"))}
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          aria-pressed={preview}
        >
          {preview ? (
            <Pencil className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}{" "}
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div className="min-h-[120px] px-3 py-2 text-sm">
          {value.trim() ? (
            <MarkdownLite text={value} />
          ) : (
            <span className="text-slate-400">Nothing to preview.</span>
          )}
        </div>
      ) : (
        <Textarea
          ref={ref}
          id={id}
          name={name}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={onKeyDown}
          className="min-h-[120px] rounded-none border-0 shadow-none focus:ring-0"
        />
      )}
      {name && preview && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
