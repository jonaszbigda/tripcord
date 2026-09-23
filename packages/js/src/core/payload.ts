import type { TimelineEvent, TimelineReason, TimelineMeta, TimelinePayload } from "./types";

export function buildPayload(
  sessionId: string,
  reason: TimelineReason,
  events: TimelineEvent[],
  meta: Omit<TimelineMeta, "capturedAt">,
  tags: string[] = []
): TimelinePayload {
  return {
    sessionId,
    reason,
    events,
    meta: { ...meta, capturedAt: Date.now() },
    // Omitted when empty, so an untagged client works against a server that
    // predates tags (its schema rejects unknown fields).
    ...(tags.length > 0 ? { tags } : {}),
  };
}
