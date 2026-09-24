"use client";

import { useMemo } from "react";

/**
 * Renders sanitised e-mail HTML inside a sandboxed iframe (no scripts, no
 * forms, no top navigation) so the message can never run in the app
 * origin. The document is written with srcdoc, so nothing is fetched from
 * the CRM; remote images were already blocked by the sanitiser.
 */
export function EmailHtml({
  html,
  cidBase,
}: {
  html: string;
  cidBase: string;
}) {
  const doc = useMemo(() => {
    const withCids = html.replace(
      /src="cid:([^"]+)"/g,
      (_m, cid: string) => `src="${cidBase}${encodeURIComponent(cid)}"`,
    );
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><base target="_blank"><style>
      :root{color-scheme:light dark}
      body{margin:0;padding:4px 2px;font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b;background:transparent;overflow-wrap:anywhere}
      @media (prefers-color-scheme: dark){body{color:#e2e8f0}}
      img{max-width:100%;height:auto} img[data-blocked-src]{display:inline-block;min-width:16px;min-height:16px;border:1px dashed #94a3b8;background:#f1f5f9;color:#64748b;font-size:11px;padding:2px 4px}
      blockquote{border-left:2px solid #cbd5e1;margin:4px 0;padding-left:8px;color:#64748b} table{max-width:100%} pre{white-space:pre-wrap}
    </style></head><body>${withCids}</body></html>`;
  }, [html, cidBase]);
  return (
    <iframe
      title="E-mail content"
      sandbox=""
      srcDoc={doc}
      className="block w-full border-0"
      style={{ minHeight: 60, height: 320 }}
      onLoad={(e) => {
        const f = e.currentTarget;
        try {
          const h = f.contentDocument?.documentElement?.scrollHeight;
          if (h) f.style.height = `${Math.min(Math.max(h + 8, 60), 4000)}px`;
        } catch {
          /* cross-origin under sandbox: keep default height */
        }
      }}
    />
  );
}
