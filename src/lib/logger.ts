import pino from "pino";

/**
 * Structured server logger. Secrets are redacted by path so that a stray
 * `log.info({ token })` never writes a credential to disk.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "*.password",
      "*.accessToken",
      "*.refreshToken",
      "*.access_token",
      "*.refresh_token",
      "*.apiToken",
      "*.clientSecret",
      "*.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
    ],
    censor: "[redacted]",
  },
  base: undefined,
});

export type Logger = typeof logger;
