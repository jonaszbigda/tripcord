import { createBuffer } from "./buffer";
import { buildPayload } from "./payload";
import { warnOnRiskyKeys } from "./guardrails";
import { normalizeTags } from "./tags";
import type { CaptureOptions, TimelineEvent, TimelinePayload, TimelineMeta } from "./types";

export interface TracerConfig {
  sessionId: string;
  maxEvents?: number;
  seedEvents?: TimelineEvent[];
  send: (payload: TimelinePayload) => void;
  getMeta: () => Omit<TimelineMeta, "capturedAt">;
  onBufferChange?: (events: TimelineEvent[]) => void;
}

export interface Tracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void;
  /** `name` is the error's constructor name, e.g. "TypeError", when known. */
  captureError(message: string, name?: string): void;
  captureUnhandledRejection(message: string, name?: string): void;
  traceElement(label: string): void;
  setTags(tags: string[]): void;
  clearTags(): void;
}

export function createTracer(config: TracerConfig): Tracer {
  const buffer = createBuffer(config.maxEvents ?? 50, config.seedEvents ?? []);
  // In memory only: the app sets them again after a reload.
  let scopeTags: string[] = [];

  function pushEvent(event: TimelineEvent): void {
    buffer.push(event);
    config.onBufferChange?.(buffer.getAll());
  }

  function flush(reason: TimelinePayload["reason"], captureTags?: unknown): void {
    // Capture tags are normalized on their own first: spreading a caller's raw
    // value would split a string like "checkout" into one-letter tags.
    const extra = captureTags === undefined ? [] : normalizeTags(captureTags);
    const tags = normalizeTags([...scopeTags, ...extra]);
    const payload = buildPayload(config.sessionId, reason, buffer.getAll(), config.getMeta(), tags);
    config.send(payload);
  }

  return {
    track(name, data) {
      warnOnRiskyKeys(data);
      pushEvent({ timestamp: Date.now(), type: "custom", name, data });
    },
    capture(name, data, options) {
      warnOnRiskyKeys(data);
      flush({ type: "manual", name, data }, options?.tags);
    },
    captureError(message, name) {
      flush({ type: "error", message, ...(name ? { name } : {}) });
    },
    captureUnhandledRejection(message, name) {
      flush({ type: "unhandledrejection", message, ...(name ? { name } : {}) });
    },
    traceElement(label) {
      pushEvent({ timestamp: Date.now(), type: "trace", name: label });
    },
    setTags(tags) {
      scopeTags = normalizeTags(tags);
    },
    clearTags() {
      scopeTags = [];
    },
  };
}
