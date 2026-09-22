import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MSP CRM", template: "%s · MSP CRM" },
  description: "CRM for managed service providers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
