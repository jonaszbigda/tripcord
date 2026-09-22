import { createTracer as createCoreTracer } from "../core/tracer";
import type { TimelineEvent } from "../core/types";
import { getOrCreateSessionId } from "./sessionId";
import { readBuffer, writeBuffer } from "./storage";
import { createSend } from "./transport";
import { attachErrorHooks, attachTraceAttributeListener } from "./hooks";
import { isBrowserEnvironment } from "./env";

export interface CreateTracerConfig {
  endpoint: string;
  apiKey: string;
  maxEvents?: number;
  sessionId?: string;
  seedEvents?: TimelineEvent[];
  captureErrors?: boolean;
  captureTraceAttribute?: boolean;
}

export interface BrowserTracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>): void;
  dispose(): void;
}

export function createTracer(config: CreateTracerConfig): BrowserTracer {
  if (!isBrowserEnvironment()) {
    return { track() {}, capture() {}, dispose() {} };
  }

  const sessionId = config.sessionId ?? getOrCreateSessionId();
  const seedEvents = readBuffer() ?? config.seedEvents;

  const core = createCoreTracer({
    sessionId,
    maxEvents: config.maxEvents,
    seedEvents,
    send: createSend(config.endpoint, config.apiKey),
    getMeta: () => ({ url: location.href, userAgent: navigator.userAgent }),
    onBufferChange: writeBuffer,
  });

  const disposers: Array<() => void> = [];
  if (config.captureErrors ?? true) {
    disposers.push(attachErrorHooks(core));
  }
  if (config.captureTraceAttribute ?? true) {
    disposers.push(attachTraceAttributeListener(core));
  }

  return {
    track: core.track,
    capture: core.capture,
    dispose() {
      disposers.forEach((dispose) => dispose());
    },
  };
}
