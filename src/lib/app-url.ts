/**
 * Absolute URL for a path on this app. Behind a reverse proxy the incoming
 * request URL carries the container's internal host (e.g. http://abc123:3000),
 * so redirects must be built from APP_URL, falling back to the request only
 * when APP_URL is not configured (local development).
 */
export function appUrl(path: string, requestUrl: string) {
  const base = process.env.APP_URL?.trim();
  return new URL(path, base && /^https?:\/\//.test(base) ? base : requestUrl);
}
