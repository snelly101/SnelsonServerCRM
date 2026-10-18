/** The label that pops out beside an icon-rail control on hover or keyboard focus. The control needs `group relative`. */
export function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-40 ml-3 inline-flex h-8 -translate-x-1 -translate-y-1/2 items-center whitespace-nowrap rounded-full bg-selection px-3 text-[13px] font-medium text-selection-fg opacity-0 shadow-pop transition-[opacity,transform] duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
    >
      <span className="absolute -left-1 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 rounded-[2px] bg-selection" aria-hidden />
      {children}
    </span>
  );
}
