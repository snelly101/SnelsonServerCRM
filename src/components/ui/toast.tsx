"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "success" | "error" | "info";
type Toast = { id: number; tone: Tone; message: string };

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

const styles: Record<Tone, { box: string; Icon: typeof Info }> = {
  success: { box: "border-green-200 bg-green-50 text-green-900", Icon: CheckCircle2 },
  error: { box: "border-red-200 bg-red-50 text-red-900", Icon: XCircle },
  info: { box: "border-slate-200 bg-surface text-slate-900", Icon: Info },
};

/**
 * Brief confirmation messages shown bottom-right after an action completes.
 * Mounted once in the app shell; use `useToast()` anywhere below it.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((all) => all.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: Tone = "success") => {
      const id = ++seq.current;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => {
          const { box, Icon } = styles[t.tone];
          return (
            <div key={t.id} role="status" className={cn("pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg", box)}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="flex-1">{t.message}</div>
              <button type="button" onClick={() => dismiss(t.id)} className="rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Returns a function that shows a toast. Safe to call outside the provider (no-op), so components stay usable in tests. */
export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ?? (() => {});
}
