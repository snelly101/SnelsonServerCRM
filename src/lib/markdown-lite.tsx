import type { ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for customer notes. It builds React
 * elements directly, so note bodies can never inject HTML. Supported:
 * headings (#, ##, ###), paragraphs, bullet and numbered lists, `code`,
 * **bold**, *italic*, [links](https://…) with http(s)/mailto/tel only, and
 * a horizontal rule (---). Everything else is shown as plain text.
 */
import { parseBlocks, safeHref } from "./markdown-parse";
export {
  parseBlocks,
  safeHref,
  markdownExcerpt,
  type Block,
} from "./markdown-parse";

/** Inline formatting: code, bold, italic, links. Returns React nodes. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${k++}`;
    if (tok.startsWith("`"))
      out.push(
        <code
          key={key}
          className="rounded bg-slate-100 px-1 font-mono text-[12px]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    else if (tok.startsWith("**"))
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*"))
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = lm ? safeHref(lm[2]) : null;
      if (lm && href)
        out.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-700 underline"
          >
            {lm[1]}
          </a>,
        );
      else out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = parseBlocks(text);
  return (
    <div
      className={
        className ?? "space-y-2 text-[13px] leading-relaxed text-slate-800"
      }
    >
      {blocks.map((b, i) => {
        if (b.type === "h") {
          const cls =
            b.level === 1
              ? "text-base font-semibold"
              : b.level === 2
                ? "text-sm font-semibold"
                : "text-[13px] font-semibold";
          return b.level === 1 ? (
            <h3 key={i} className={cls}>
              {renderInline(b.text, `h${i}`)}
            </h3>
          ) : b.level === 2 ? (
            <h4 key={i} className={cls}>
              {renderInline(b.text, `h${i}`)}
            </h4>
          ) : (
            <h5 key={i} className={cls}>
              {renderInline(b.text, `h${i}`)}
            </h5>
          );
        }
        if (b.type === "hr") return <hr key={i} className="border-slate-200" />;
        if (b.type === "ul" || b.type === "ol") {
          const items = b.items.map((it, j) => (
            <li key={j}>{renderInline(it, `l${i}-${j}`)}</li>
          ));
          return b.type === "ul" ? (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {items}
            </ul>
          ) : (
            <ol key={i} className="list-decimal space-y-0.5 pl-5">
              {items}
            </ol>
          );
        }
        if (b.type !== "p") return null;
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>
                {renderInline(l, `p${i}-${j}`)}
                {j < b.lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
