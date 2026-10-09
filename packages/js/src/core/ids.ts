/**
 * A random opaque id for a breadcrumb, so the same event can be deduped when a
 * buffer is re-sent across captures. Uses the platform's `crypto.randomUUID`
 * when present (browsers, Node 18+, jsdom), and a v4-shaped fallback otherwise.
 */
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
