/**
 * Pure parsing half of the customer-notes Markdown subset (no JSX), shared by
 * the renderer in markdown-lite.tsx and unit-testable on its own.
 */
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:)/i;

export function safeHref(href: string): string | null {
  const h = href.trim();
  return SAFE_LINK.test(h) ? h : null;
}

export type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; lines: string[] }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "hr" };

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "h", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push({ type: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,})\s*$/.test(lines[i])
    )
      para.push(lines[i++]);
    blocks.push({ type: "p", lines: para });
  }
  return blocks;
}

/** Plain-text excerpt for previews and search results. */
export function markdownExcerpt(markdown: string, max = 160) {
  const plain = markdown
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** Inline markers stripped, one line per block line: the plain-text twin of a Markdown body (used for e-mail text parts and search). */
export function markdownToPlainText(markdown: string): string {
  const strip = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*\s][^*]*)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_m, text: string, href: string) =>
          text.trim() === href.trim() ? href : `${text} (${href})`,
      );
  const out: string[] = [];
  for (const b of parseBlocks(markdown)) {
    if (b.type === "h") out.push(strip(b.text).toUpperCase());
    else if (b.type === "p") out.push(b.lines.map(strip).join("\n"));
    else if (b.type === "ul")
      out.push(b.items.map((i) => `- ${strip(i)}`).join("\n"));
    else if (b.type === "ol")
      out.push(b.items.map((i, n) => `${n + 1}. ${strip(i)}`).join("\n"));
    else out.push("----------");
  }
  return out.join("\n\n");
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inlineHtml(text: string): string {
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out += `<code>${esc(tok.slice(1, -1))}</code>`;
    else if (tok.startsWith("**"))
      out += `<strong>${esc(tok.slice(2, -2))}</strong>`;
    else if (tok.startsWith("*")) out += `<em>${esc(tok.slice(1, -1))}</em>`;
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = lm ? safeHref(lm[2]) : null;
      out += lm && href ? `<a href="${esc(href)}">${esc(lm[1])}</a>` : esc(tok);
    }
    last = m.index + tok.length;
  }
  return out + esc(text.slice(last));
}

/** Markdown subset → simple, self-contained HTML (no scripts, no styles beyond inline basics) for outbound e-mail. */
export function markdownToHtml(markdown: string): string {
  const parts: string[] = [];
  for (const b of parseBlocks(markdown)) {
    if (b.type === "h")
      parts.push(`<h${b.level + 2}>${inlineHtml(b.text)}</h${b.level + 2}>`);
    else if (b.type === "p")
      parts.push(`<p>${b.lines.map(inlineHtml).join("<br>")}</p>`);
    else if (b.type === "ul")
      parts.push(
        `<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`,
      );
    else if (b.type === "ol")
      parts.push(
        `<ol>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ol>`,
      );
    else parts.push("<hr>");
  }
  return parts.join("\n");
}
