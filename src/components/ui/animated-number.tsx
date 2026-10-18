"use client";

import { useEffect, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";

/**
 * A number that counts up to its value when it first appears, and again
 * whenever the value changes. Server-rendered with the final value so there
 * is nothing to hydrate differently; the count-up starts after mount.
 */
export function AnimatedNumber({
  value,
  format = "int",
  currency = "GBP",
  locale = "en-GB",
  maximumFractionDigits,
  className,
}: {
  value: number;
  format?: "int" | "money" | "decimal";
  currency?: string;
  locale?: string;
  maximumFractionDigits?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const fmt = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: format === "money" ? "currency" : "decimal",
      currency: format === "money" ? currency : undefined,
      maximumFractionDigits: maximumFractionDigits ?? (format === "int" ? 0 : format === "money" ? 2 : 1),
      minimumFractionDigits: format === "money" ? 2 : 0,
    }).format(n);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (reduce || !Number.isFinite(value)) {
      setShown(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 0.9,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => setShown(v),
    });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span className={className} aria-label={fmt(value)}>
      {fmt(shown)}
    </span>
  );
}
