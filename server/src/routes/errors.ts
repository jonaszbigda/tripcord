import { hasControlChars } from "../names";

/** An error the global error handler turns into `{ error: message }` with this status. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Trims a user/org/project name. A blank one, or one holding control
 * characters, is a 400 whose message starts with `label` (e.g. "Project name").
 */
export function requireName(value: string, label: string): string {
  const name = value.trim();
  if (!name) {
    throw httpError(400, `${label} is required`);
  }
  if (hasControlChars(name)) {
    throw httpError(400, `${label} must not contain control characters`);
  }
  return name;
}
