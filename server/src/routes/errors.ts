/** An error the global error handler turns into `{ error: message }` with this status. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Trims a user/org/project name; a blank one is a 400 with `message`. */
export function requireName(value: string, message: string): string {
  const name = value.trim();
  if (!name) {
    throw httpError(400, message);
  }
  return name;
}
