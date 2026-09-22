import type { TimelineEvent, TimelineReason, TimelineMeta, TimelinePayload } from "./types";

export function buildPayload(
  sessionId: string,
  reason: TimelineReason,
  events: TimelineEvent[],
  meta: Omit<TimelineMeta, "capturedAt">
): TimelinePayload {
  return {
    sessionId,
    reason,
    events,
    meta: { ...meta, capturedAt: Date.now() },
  };
}
