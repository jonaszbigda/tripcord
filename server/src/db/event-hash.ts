import { createHash } from "node:crypto";
import type { TimelineEvent } from "@tripcord/js";

/**
 * A canonical JSON encoding: object keys sorted at every level, so two events
 * whose `data` differs only in key order hash the same.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The key an event dedupes on. A client-supplied `id` wins; otherwise the event
 * is identified by its content. Two copies of the same breadcrumb — the same
 * buffer re-sent across captures, or a seeded SSR event — collapse, while a
 * genuinely new occurrence (a different `timestamp`) does not.
 */
export function eventDedupeKey(event: TimelineEvent): string {
  if (event.id) {
    return event.id;
  }
  const canonical = stableStringify([event.timestamp, event.type, event.name, event.data ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Merges any number of event lists into one: deduped by {@link eventDedupeKey},
 * ordered oldest first, and trimmed to the newest `cap` (default: no limit).
 */
export function mergeEvents(lists: TimelineEvent[][], cap = Number.POSITIVE_INFINITY): TimelineEvent[] {
  const byKey = new Map<string, TimelineEvent>();
  for (const list of lists) {
    for (const event of list) {
      const key = eventDedupeKey(event);
      if (!byKey.has(key)) {
        byKey.set(key, event);
      }
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
  return cap === Number.POSITIVE_INFINITY ? sorted : sorted.slice(-cap);
}
