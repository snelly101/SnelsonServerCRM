/**
 * Splits a plain-text reply into the new part and the quoted history /
 * signature, so the conversation shows what was written and folds the rest.
 * Heuristics cover Outlook ("From: … Sent: …"), "-----Original Message-----",
 * Gmail/Apple ("On … wrote:"), "> " quoting and the "-- " signature marker.
 */
const CUT_LINES = [
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{5,}$/,
  /^From:\s.+$/,
  /^De\s?:\s.+$/,
  /^Von:\s.+$/,
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^Sent from my (iPhone|iPad|Android|Galaxy|Samsung)/i,
  /^Get Outlook for (iOS|Android)/i,
];
const ON_WROTE = /^On .{3,200}wrote:\s*$/;

export function splitQuotedText(text: string): {
  body: string;
  quoted: string | null;
} {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l === "--" || l === "-- ") {
      cut = i;
      break;
    }
    if (
      ON_WROTE.test(l) ||
      (i + 1 < lines.length &&
        /^On .+/.test(l) &&
        /wrote:\s*$/.test(lines[i + 1].trim()))
    ) {
      cut = i;
      break;
    }
    if (CUT_LINES.some((re) => re.test(l))) {
      // "From:" only counts as a cut when followed by a header-looking block.
      if (
        /^From:/i.test(l) &&
        !lines
          .slice(i + 1, i + 5)
          .some((x) => /^(Sent|To|Subject|Date):/i.test(x.trim()))
      )
        continue;
      cut = i;
      break;
    }
    if (l.startsWith(">")) {
      // The first quoted block after some new text starts the quote.
      const rest = lines.slice(i).filter((x) => x.trim());
      if (
        rest.length &&
        rest.every(
          (x) =>
            x.trim().startsWith(">") ||
            CUT_LINES.some((re) => re.test(x.trim())) ||
            ON_WROTE.test(x.trim()),
        )
      ) {
        cut = i;
        break;
      }
    }
  }
  if (cut <= 0)
    return {
      body: text.trim(),
      quoted: cut === 0 ? text.trim() || null : null,
    };
  const body = lines.slice(0, cut).join("\n").trim();
  const quoted = lines.slice(cut).join("\n").trim();
  return { body: body || text.trim(), quoted: body ? quoted || null : null };
}
