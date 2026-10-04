import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "pg-boss", "pino"],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
  poweredByHeader: false,
  async redirects() {
    // Helpdesk administration moved under Settings; keep old bookmarks and runbook links working.
    return [
      { source: "/helpdesk/admin", destination: "/settings/helpdesk", permanent: true },
      { source: "/helpdesk/admin/:path*", destination: "/settings/helpdesk/:path*", permanent: true },
      // Finance, the billing run, findings, service coverage, renewals and price reviews were joined into one Billing area.
      { source: "/finance", destination: "/billing", permanent: true },
      { source: "/finance/billing-run", destination: "/billing/run", permanent: true },
      { source: "/finance/findings", destination: "/billing/exceptions", permanent: true },
      { source: "/finance/services", destination: "/billing/services", permanent: true },
      { source: "/finance/drafts/:path*", destination: "/billing/drafts/:path*", permanent: true },
      { source: "/contracts/renewals", destination: "/billing/renewals", permanent: true },
      { source: "/contracts/price-reviews", destination: "/billing/renewals?view=pricing", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
