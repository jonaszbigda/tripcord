import { createBuffer } from "./buffer";
import { buildPayload } from "./payload";
import { warnOnRiskyKeys } from "./guardrails";
import type { TimelineEvent, TimelinePayload, TimelineMeta } from "./types";

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
  capture(name?: string, data?: Record<string, unknown>): void;
  captureError(message: string): void;
  captureUnhandledRejection(message: string): void;
  traceElement(label: string): void;
}

export function createTracer(config: TracerConfig): Tracer {
  const buffer = createBuffer(config.maxEvents ?? 50, config.seedEvents ?? []);

  function pushEvent(event: TimelineEvent): void {
    buffer.push(event);
    config.onBufferChange?.(buffer.getAll());
  }

  function flush(reason: TimelinePayload["reason"]): void {
    const payload = buildPayload(config.sessionId, reason, buffer.getAll(), config.getMeta());
    config.send(payload);
  }

  return {
    track(name, data) {
      warnOnRiskyKeys(data);
      pushEvent({ timestamp: Date.now(), type: "custom", name, data });
    },
    capture(name, data) {
      warnOnRiskyKeys(data);
      flush({ type: "manual", name, data });
    },
    captureError(message) {
      flush({ type: "error", message });
    },
    captureUnhandledRejection(message) {
      flush({ type: "unhandledrejection", message });
    },
    traceElement(label) {
      pushEvent({ timestamp: Date.now(), type: "trace", name: label });
    },
  };
}
