"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ActionResult } from "@/lib/action-result";

export function Field({
  label,
  htmlFor,
  help,
  error,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  error?: string[] | string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const err = Array.isArray(error) ? error[0] : error;
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="field-label">
        {label}
        {required && <span className="text-red-600 ml-0.5" aria-hidden>*</span>}
      </label>
      {children}
      {help && !err && <p className="field-help">{help}</p>}
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...props }, ref) {
    return <input ref={ref} className={cn("input", className)} aria-invalid={invalid || undefined} {...props} />;
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...props }, ref) {
    return <textarea ref={ref} className={cn("input min-h-[80px]", className)} aria-invalid={invalid || undefined} {...props} />;
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn("input pr-8", className)} aria-invalid={invalid || undefined} {...props}>
        {children}
      </select>
    );
  },
);

export function Checkbox({ label, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-sm text-slate-700", className)}>
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" {...props} />
      {label}
    </label>
  );
}

export function SubmitButton({ children, ...props }: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...props}>
      {children}
    </Button>
  );
}

export function FormMessage({ result }: { result: ActionResult<unknown> | null }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
        <span>Saved.</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <span>{result.error}</span>
    </div>
  );
}

export function fieldErrors(result: ActionResult<unknown> | null, key: string): string[] | undefined {
  if (!result || result.ok) return undefined;
  return result.fieldErrors?.[key];
}
