import { ZodError } from "zod";
import { ForbiddenError } from "./permissions";
import { logger } from "./logger";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Wraps a server action so validation and permission failures become readable
 * results instead of opaque "server error" messages. Unknown errors are logged
 * server-side and returned as a generic message.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".") || "_";
        (fieldErrors[key] ??= []).push(issue.message);
      }
      return fail("Please correct the highlighted fields.", fieldErrors);
    }
    if (err instanceof ForbiddenError) return fail(err.message);
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof Error && /signed out/i.test(err.message)) return fail(err.message);
    if (err instanceof ActionError) return fail(err.message, err.fieldErrors);
    logger.error({ err }, "Unhandled server action error");
    return fail("Something went wrong. The error has been logged.");
  }
}

/** Throw this from an action for a user-facing message. */
export class ActionError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}
