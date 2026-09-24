/**
 * Allow-list HTML sanitiser for inbound e-mail. No dependency: a small
 * tokenizer that keeps a fixed set of tags and attributes, drops scripts,
 * styles, forms, iframes, event handlers and javascript: URLs, and blocks
 * remote images (their src moves to data-blocked-src so the UI can offer
 * "load images"). cid: images are rewritten through `resolveCid`.
 * Output is meant for an iframe with `sandbox` (no scripts) as a second layer.
 */
const ALLOWED: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  b: new Set(),
  strong: new Set(),
  i: new Set(),
  em: new Set(),
  u: new Set(),
  s: new Set(),
  p: new Set(),
  br: new Set(),
  div: new Set(),
  span: new Set(),
  blockquote: new Set(),
  pre: new Set(),
  code: new Set(),
  ul: new Set(),
  ol: new Set(),
  li: new Set(),
  h1: new Set(),
  h2: new Set(),
  h3: new Set(),
  h4: new Set(),
  h5: new Set(),
  h6: new Set(),
  table: new Set(["border", "cellpadding", "cellspacing", "width"]),
  thead: new Set(),
  tbody: new Set(),
  tfoot: new Set(),
  tr: new Set(),
  td: new Set(["colspan", "rowspan", "width", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "width", "align", "valign"]),
  img: new Set(["src", "alt", "width", "height", "title"]),
  hr: new Set(),
  sup: new Set(),
  sub: new Set(),
  small: new Set(),
  font: new Set(["color", "face", "size"]),
  center: new Set(),
};
const VOID = new Set(["br", "img", "hr"]);
/** Content of these is dropped entirely, not just the tags. */
const DROP_CONTENT = new Set([
  "script",
  "style",
  "head",
  "title",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
  "form",
  "button",
  "input",
  "select",
  "textarea",
]);
const SAFE_STYLE =
  /^(color|background-color|font-weight|font-style|text-decoration|text-align|font-size|font-family|margin[a-z-]*|padding[a-z-]*|border[a-z-]*|width|height|max-width|white-space|line-height)$/i;

const escapeText = (s: string) =>
  s
    .replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  s
    .replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function decodeEntities(s: string) {
  return s.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (m, e: string) => {
      const k = e.toLowerCase();
      if (k === "amp") return "&";
      if (k === "lt") return "<";
      if (k === "gt") return ">";
      if (k === "quot") return '"';
      if (k === "apos") return "'";
      if (k === "nbsp") return " ";
      const code = k.startsWith("#x")
        ? parseInt(k.slice(2), 16)
        : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    },
  );
}

function safeUrl(
  raw: string,
  kind: "href" | "img",
  resolveCid?: (cid: string) => string | null,
): { value: string | null; blocked?: string } {
  const v = decodeEntities(raw)
    .trim()
    .replace(/[\u0000-\u001f]/g, "");
  if (!v) return { value: null };
  const lower = v.toLowerCase();
  if (kind === "href")
    return /^(https?:\/\/|mailto:|tel:)/.test(lower)
      ? { value: v }
      : { value: null };
  if (lower.startsWith("cid:")) {
    const r = resolveCid?.(v.slice(4).replace(/^<|>$/g, ""));
    return { value: r ?? null };
  }
  if (lower.startsWith("data:image/"))
    return { value: v.length < 200_000 ? v : null };
  if (/^https?:\/\//.test(lower)) return { value: null, blocked: v };
  return { value: null };
}

function sanitizeStyle(style: string) {
  const out: string[] = [];
  for (const decl of decodeEntities(style).split(";")) {
    const [prop, ...rest] = decl.split(":");
    const val = rest.join(":").trim();
    if (!prop || !val) continue;
    if (!SAFE_STYLE.test(prop.trim())) continue;
    if (/url\s*\(|expression|javascript|@import|behavior/i.test(val)) continue;
    out.push(`${prop.trim().toLowerCase()}: ${val.replace(/[<>"]/g, "")}`);
  }
  return out.join("; ");
}

export function sanitizeEmailHtml(
  html: string,
  opts: {
    resolveCid?: (cid: string) => string | null;
    allowRemoteImages?: boolean;
  } = {},
): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const out: string[] = [];
  const open: string[] = [];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|[^<]+|</g;
  let dropDepth: string | null = null;
  let m: RegExpExecArray | null;
  const attrRe =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok.startsWith("<!--") || tok.startsWith("<![CDATA[")) continue;
    if (tok === "<") {
      if (!dropDepth) out.push("&lt;");
      continue;
    }
    if (!tok.startsWith("<")) {
      if (!dropDepth) out.push(escapeText(tok));
      continue;
    }
    const name = (m[1] ?? "").toLowerCase();
    const closing = tok.startsWith("</");
    if (dropDepth) {
      if (closing && name === dropDepth) dropDepth = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing && !tok.endsWith("/>")) dropDepth = name;
      continue;
    }
    const allowed = ALLOWED[name];
    if (!allowed) continue; // unknown tag: drop the tag, keep its text
    if (closing) {
      if (VOID.has(name)) continue;
      const idx = open.lastIndexOf(name);
      if (idx === -1) continue;
      while (open.length > idx) out.push(`</${open.pop()}>`);
      continue;
    }
    const attrs: string[] = [];
    let am: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    const rawAttrs = m[2] ?? "";
    while ((am = attrRe.exec(rawAttrs))) {
      const an = am[1].toLowerCase();
      const av = am[2] ?? am[3] ?? am[4] ?? "";
      if (an.startsWith("on")) continue;
      if (an === "style") {
        const st = sanitizeStyle(av);
        if (st) attrs.push(`style="${escapeAttr(st)}"`);
        continue;
      }
      if (!allowed.has(an)) continue;
      if (an === "href") {
        const u = safeUrl(av, "href");
        if (u.value)
          attrs.push(
            `href="${escapeAttr(u.value)}" target="_blank" rel="noopener noreferrer nofollow"`,
          );
        continue;
      }
      if (an === "src") {
        const u = safeUrl(av, "img", opts.resolveCid);
        if (u.value) attrs.push(`src="${escapeAttr(u.value)}"`);
        else if (u.blocked) {
          if (opts.allowRemoteImages)
            attrs.push(`src="${escapeAttr(u.blocked)}"`);
          else {
            blockedImages++;
            attrs.push(
              `data-blocked-src="${escapeAttr(u.blocked)}" alt="[remote image blocked]"`,
            );
          }
        }
        continue;
      }
      attrs.push(
        `${an}="${escapeAttr(decodeEntities(av).replace(/[<>"]/g, ""))}"`,
      );
    }
    if (VOID.has(name))
      out.push(`<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
    else {
      out.push(`<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
      open.push(name);
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return { html: out.join(""), blockedImages };
}

/** Plain text from HTML: block tags become line breaks, entities decoded, whitespace collapsed per line. */
export function htmlToText(html: string) {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) =>
      decodeEntities(l)
        .replace(/[ \t ]+/g, " ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}
