const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checked before querying, so Postgres never raises a uuid cast error.
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
