import { createTracer } from "./browser/createTracer";
import type { CreateTracerConfig } from "./browser/createTracer";

export { createTracer };
export type { CreateTracerConfig } from "./browser/createTracer";
export type { TimelineEvent, TimelinePayload, TimelineReason, TimelineMeta } from "./core/types";
export { redact } from "./core/redact";

let defaultTracer: ReturnType<typeof createTracer> | undefined;

export function init(config: CreateTracerConfig): { dispose: () => void } {
  if (defaultTracer) {
    console.warn("[repro] init() called again — replacing the existing instance.");
    defaultTracer.dispose();
  }
  defaultTracer = createTracer(config);
  return {
    dispose() {
      defaultTracer?.dispose();
      defaultTracer = undefined;
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

export function capture(name?: string, data?: Record<string, unknown>): void {
  if (!defaultTracer) {
    console.warn("[repro] capture() called before init().");
    return;
  }
  defaultTracer.capture(name, data);
}
