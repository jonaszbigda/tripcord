import { createTracer } from "./browser/createTracer";
import type { CreateTracerConfig } from "./browser/createTracer";
import type { CaptureOptions } from "./core/types";

export { createTracer };
export type { CreateTracerConfig } from "./browser/createTracer";
export type { TimelineEvent, TimelinePayload, TimelineReason, TimelineMeta, CaptureOptions } from "./core/types";
export { redact } from "./core/redact";

let defaultTracer: ReturnType<typeof createTracer> | undefined;

export function init(config: CreateTracerConfig): { dispose: () => void } {
  if (defaultTracer) {
    console.warn("[repro] init() called again — replacing the existing instance.");
    defaultTracer.dispose();
  }
  const instance = createTracer(config);
  defaultTracer = instance;
  return {
    dispose() {
      instance.dispose();
      if (defaultTracer === instance) {
        defaultTracer = undefined;
      }
    },
  };
}

export function track(name: string, data?: Record<string, unknown>): void {
  if (!defaultTracer) {
    console.warn("[repro] track() called before init().");
    return;
  }
  defaultTracer.track(name, data);
}

export function capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void {
  if (!defaultTracer) {
    console.warn("[repro] capture() called before init().");
    return;
  }
  defaultTracer.capture(name, data, options);
}

/** Replaces the tags every following timeline carries, until changed or cleared. */
export function setTags(tags: string[]): void {
  if (!defaultTracer) {
    console.warn("[repro] setTags() called before init().");
    return;
  }
  defaultTracer.setTags(tags);
}

export function clearTags(): void {
  if (!defaultTracer) {
    console.warn("[repro] clearTags() called before init().");
    return;
  }
  defaultTracer.clearTags();
}
