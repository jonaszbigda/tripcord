import { createBuffer } from "../core/buffer";
import { warnOnRiskyKeys } from "../core/guardrails";
import { randomId } from "../core/ids";
import { buildPayload } from "../core/payload";
import { normalizeTags } from "../core/tags";
import type { CaptureOptions, TimelineEvent, TimelineMeta } from "../core/types";
import { createJsonSend } from "./transport";

export interface NodeTracerConfig {
  /** The capture endpoint, e.g. `https://tripcord.example.com/v1/timeline`. */
  endpoint: string;
  /**
   * The staging endpoint. Derived from `endpoint` by replacing a trailing
   * `/timeline` with `/events`; required only when `endpoint` doesn't end so.
   */
  eventsEndpoint?: string;
  apiKey: string;
  /** Any opaque session id. Minted with `createSessionId()` when omitted. */
  sessionId?: string;
  /**
   * When true (default), each `track()` is posted to `/v1/events` immediately
   * and `capture()` sends only the reason. When false, events stay in memory
   * until `capture()` ships them (the request-scoped SSR style).
   */
  stageEvents?: boolean;
  maxEvents?: number;
  seedEvents?: TimelineEvent[];
  /** The request's URL and user agent, recorded on every capture. */
  meta?: { url?: string; userAgent?: string };
}

export interface NodeTracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void;
  setTags(tags: string[]): void;
  clearTags(): void;
  getSessionId(): string;
  /** The in-memory events, for serializing `{ sessionId, seedEvents }` into a page. */
  getEvents(): TimelineEvent[];
  /** Resolves once every in-flight send has settled. */
  flush(): Promise<void>;
}

/** A fresh opaque session id. */
export function createSessionId(): string {
  return randomId();
}

function eventsUrl(config: NodeTracerConfig): string {
  if (config.eventsEndpoint !== undefined) {
    return config.eventsEndpoint;
  }
  const url = new URL(config.endpoint);
  const suffix = "/timeline";
  if (!url.pathname.endsWith(suffix)) {
    throw new Error("eventsEndpoint is required when endpoint does not end in /timeline");
  }
  url.pathname = `${url.pathname.slice(0, -suffix.length)}/events`;
  return url.toString();
}

export function createTracer(config: NodeTracerConfig): NodeTracer {
  const sessionId = config.sessionId ?? createSessionId();
  const stageEvents = config.stageEvents ?? true;
  const buffer = createBuffer(config.maxEvents ?? 50, config.seedEvents ?? []);
  let scopeTags: string[] = [];
  const inFlight = new Set<Promise<void>>();

  const timeline = createJsonSend(config.endpoint, config.apiKey, inFlight);
  const stage = stageEvents ? createJsonSend(eventsUrl(config), config.apiKey, inFlight) : undefined;
  const getMeta = (): Omit<TimelineMeta, "capturedAt"> => ({
    url: config.meta?.url ?? "",
    userAgent: config.meta?.userAgent ?? "",
  });

  return {
    track(name, data) {
      warnOnRiskyKeys(data);
      const event: TimelineEvent = { timestamp: Date.now(), type: "custom", name, data, id: randomId(), source: "server" };
      buffer.push(event);
      if (stage) {
        void stage({ sessionId, events: [event] });
      }
    },
    capture(name, data, options) {
      warnOnRiskyKeys(data);
      const extra = options?.tags === undefined ? [] : normalizeTags(options.tags);
      const tags = normalizeTags([...scopeTags, ...extra]);
      // Staged events are already on the server; the capture is just the moment.
      const events = stage ? [] : buffer.getAll();
      void timeline(buildPayload(sessionId, { type: "manual", name, data }, events, getMeta(), tags));
    },
    setTags(tags) {
      scopeTags = normalizeTags(tags);
    },
    clearTags() {
      scopeTags = [];
    },
    getSessionId() {
      return sessionId;
    },
    getEvents() {
      return buffer.getAll();
    },
    flush() {
      return Promise.all([...inFlight]).then(() => undefined);
    },
  };
}
