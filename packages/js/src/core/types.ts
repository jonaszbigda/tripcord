export interface TimelineEvent {
  timestamp: number;
  type: "custom" | "error" | "unhandledrejection" | "trace";
  name: string;
  data?: Record<string, unknown>;
}

export interface TimelineReason {
  type: "error" | "unhandledrejection" | "manual";
  message?: string;
  name?: string;
  data?: Record<string, unknown>;
}

export interface TimelineMeta {
  url: string;
  userAgent: string;
  capturedAt: number;
}

export interface TimelinePayload {
  sessionId: string;
  reason: TimelineReason;
  events: TimelineEvent[];
  meta: TimelineMeta;
  /** Where the error happened; omitted when there are none. */
  tags?: string[];
}

export interface CaptureOptions {
  /** Added to the tracer's scope tags for this capture only. */
  tags?: string[];
}
