import { createTracer as createCoreTracer } from "../core/tracer";
import type { CaptureOptions, TimelineEvent } from "../core/types";
import { getOrCreateSessionId } from "./sessionId";
import { readBuffer, writeBuffer } from "./storage";
import { createSend } from "./transport";
import { attachErrorHooks, attachTraceAttributeListener } from "./hooks";
import { isBrowserEnvironment } from "./env";
import { pageUrl } from "./url";

export interface CreateTracerConfig {
  endpoint: string;
  apiKey: string;
  maxEvents?: number;
  sessionId?: string;
  seedEvents?: TimelineEvent[];
  captureErrors?: boolean;
  captureTraceAttribute?: boolean;
  /**
   * What to send as the page URL. By default only the origin and path are
   * sent: query strings and fragments often hold tokens and emails.
   */
  sanitizeUrl?: (url: URL) => string;
}

export interface BrowserTracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void;
  setTags(tags: string[]): void;
  clearTags(): void;
  dispose(): void;
}

export function createTracer(config: CreateTracerConfig): BrowserTracer {
  if (!isBrowserEnvironment()) {
    return { track() {}, capture() {}, setTags() {}, clearTags() {}, dispose() {} };
  }

  const sessionId = config.sessionId ?? getOrCreateSessionId();
  const seedEvents = readBuffer() ?? config.seedEvents;

  const core = createCoreTracer({
    sessionId,
    maxEvents: config.maxEvents,
    seedEvents,
    send: createSend(config.endpoint, config.apiKey),
    getMeta: () => ({ url: pageUrl(location.href, config.sanitizeUrl), userAgent: navigator.userAgent }),
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
    setTags: core.setTags,
    clearTags: core.clearTags,
    dispose() {
      disposers.forEach((dispose) => dispose());
    },
  };
}
