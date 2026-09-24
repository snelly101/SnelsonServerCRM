import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { parseThemePref, THEME_COOKIE, THEME_INIT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "MSP CRM", template: "%s · MSP CRM" },
  description: "CRM for managed service providers",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pref = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return (
    // suppressHydrationWarning: the inline script may set data-theme for "system" before React hydrates.
    <html lang="en-GB" data-theme-pref={pref} data-theme={pref === "system" ? undefined : pref} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
