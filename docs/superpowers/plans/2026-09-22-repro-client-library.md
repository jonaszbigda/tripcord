# repro Client Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@repro/js`, an opt-in, developer-instrumented breadcrumb timeline library for frontend bug reproduction, as a working, tested, publishable npm package.

**Architecture:** A single npm package with an environment-agnostic `core/` (buffer, payload shaping, tracer logic — no DOM access), a `browser/` adapter (DOM hooks, sessionStorage, fetch transport) that is the package's default entry point, and a thin `react/` adapter (an `ErrorBoundary`) exported via a subpath. `core/` and `browser/` communicate through plain injected callbacks (`send`, `getMeta`, `onBufferChange`) so `core/` never imports a browser global, enforced by an ESLint path-boundary rule.

**Tech Stack:** TypeScript, tsup (build), Vitest (tests, node env for `core/`, jsdom env for `browser/`/`react/`), ESLint flat config with `eslint-plugin-import`'s `no-restricted-paths`.

**Spec:** `docs/superpowers/specs/2026-09-22-repro-client-library-design.md`

## Global Constraints

- Package name: `@repro/js`, single package with subpath exports (`.` and `./react`) — not a multi-package monorepo.
- `core/` must never import anything from `browser/` or `react/` — enforced by an ESLint `no-restricted-paths` rule, not just convention.
- Default entry point (`@repro/js`, i.e. `src/index.ts`) is the browser adapter.
- Buffer persistence uses `sessionStorage`, never `localStorage`.
- Delivery uses `fetch(..., { keepalive: true })` — never `navigator.sendBeacon`.
- The only auth config is `apiKey`, sent as a fixed `X-Repro-Key` header — no general `headers` option.
- No retry/backoff for failed sends — fire-and-forget, `console.warn` on failure.
- The anonymization guardrail only warns (via `console.warn`) on risky top-level keys (`password`, `token`, `secret`, `apiKey`, `ssn`, `creditCard`) — it never blocks, strips, or throws.
- `data-trace` (not a bare `trace` attribute) is the declarative capture attribute.
- Ring buffer default size: 50 events, configurable via `maxEvents`.
- `captureErrors` and `captureTraceAttribute` both default to `true` (opt-out, not opt-in).
- Every browser-specific code path must no-op (never throw) when `window`/`document` are unavailable.
- Note filling a gap in the spec: the spec's `Core API shape` example calls `capture("payment-declined", { code: "insufficient_funds" })`, passing a `data` object, but the spec's `TimelinePayload.reason` type only listed `type`/`message`/`name`. This plan adds `data?: Record<string, unknown>` to `TimelineReason` to make that example valid — consistent with the spec's intent, just not spelled out in its type block.

---

## File Structure

```
package.json
tsconfig.json
tsup.config.ts
vitest.config.ts
eslint.config.js
src/
  index.ts                    # public entry point (browser adapter + default instance sugar)
  index.test.ts
  core/
    types.ts                  # TimelineEvent, TimelineReason, TimelineMeta, TimelinePayload
    buffer.ts                 # ring buffer
    buffer.test.ts
    guardrails.ts              # risky-key warning
    guardrails.test.ts
    redact.ts                  # redact() helper
    redact.test.ts
    payload.ts                  # buildPayload()
    payload.test.ts
    tracer.ts                   # createTracer() — the environment-agnostic engine
    tracer.test.ts
  browser/
    env.ts                     # isBrowserEnvironment()
    env.test.ts
    env.jsdom.test.ts
    storage.ts                 # sessionStorage read/write, guarded
    storage.test.ts
    sessionId.ts                # getOrCreateSessionId()
    sessionId.test.ts
    transport.ts                 # createSend() — fetch w/ keepalive
    transport.test.ts
    hooks.ts                    # attachErrorHooks(), attachTraceAttributeListener()
    hooks.test.ts
    createTracer.ts              # wires core + browser adapters together
    createTracer.test.ts
    createTracer.node.test.ts
  react/
    ErrorBoundary.tsx
    ErrorBoundary.test.tsx
    index.ts
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/index.ts`
- Test: `src/index.test.ts`

**Interfaces:**
- Produces: an `index.ts` exporting `VERSION: string` — a placeholder proving the toolchain works end-to-end; Task 11 will replace this file's contents with the real public API.

- [ ] **Step 1: Write the failing test**

`src/index.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VERSION } from "./index";

describe("toolchain smoke test", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 2: Create the config files**

`package.json`:
```json
{
  "name": "@repro/js",
  "version": "0.1.0",
  "description": "Opt-in, developer-instrumented breadcrumb timeline for frontend bug reproduction.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "sideEffects": false,
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsup": "^8.0.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0",
    "eslint": "^9.0.0",
    "@eslint/js": "^9.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "eslint-plugin-import": "^2.29.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

`eslint.config.js`:
```js
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: importPlugin,
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src/browser",
              message: "core/ must stay environment-agnostic — it cannot import from browser/.",
            },
            {
              target: "./src/core",
              from: "./src/react",
              message: "core/ must stay environment-agnostic — it cannot import from react/.",
            },
          ],
        },
      ],
    },
  },
];
```

`src/index.ts`:
```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: installs without error, creates `package-lock.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 1 test passed.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build`
Expected: creates `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts eslint.config.js src/index.ts src/index.test.ts
git commit -m "chore: scaffold @repro/js package (build, test, lint toolchain)"
```

---

### Task 2: Ring buffer

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/buffer.ts`
- Test: `src/core/buffer.test.ts`

**Interfaces:**
- Produces: `TimelineEvent` (`{ timestamp: number; type: "custom" | "error" | "unhandledrejection" | "trace"; name: string; data?: Record<string, unknown> }`), `createBuffer(maxEvents: number, seedEvents?: TimelineEvent[]): TimelineBuffer` where `TimelineBuffer = { push(event: TimelineEvent): void; getAll(): TimelineEvent[] }`.

- [ ] **Step 1: Write the failing test**

`src/core/buffer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createBuffer } from "./buffer";

describe("createBuffer", () => {
  it("returns pushed events in insertion order", () => {
    const buffer = createBuffer(50);
    buffer.push({ timestamp: 1, type: "custom", name: "a" });
    buffer.push({ timestamp: 2, type: "custom", name: "b" });
    expect(buffer.getAll()).toEqual([
      { timestamp: 1, type: "custom", name: "a" },
      { timestamp: 2, type: "custom", name: "b" },
    ]);
  });

  it("drops the oldest event once maxEvents is exceeded", () => {
    const buffer = createBuffer(2);
    buffer.push({ timestamp: 1, type: "custom", name: "a" });
    buffer.push({ timestamp: 2, type: "custom", name: "b" });
    buffer.push({ timestamp: 3, type: "custom", name: "c" });
    expect(buffer.getAll()).toEqual([
      { timestamp: 2, type: "custom", name: "b" },
      { timestamp: 3, type: "custom", name: "c" },
    ]);
  });

  it("trims seedEvents to maxEvents on creation", () => {
    const seed = [
      { timestamp: 1, type: "custom" as const, name: "a" },
      { timestamp: 2, type: "custom" as const, name: "b" },
      { timestamp: 3, type: "custom" as const, name: "c" },
    ];
    const buffer = createBuffer(2, seed);
    expect(buffer.getAll()).toEqual([seed[1], seed[2]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/buffer.test.ts`
Expected: FAIL — cannot find module `./buffer`.

- [ ] **Step 3: Write the implementation**

`src/core/types.ts`:
```ts
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
}
```

`src/core/buffer.ts`:
```ts
import type { TimelineEvent } from "./types";

export interface TimelineBuffer {
  push(event: TimelineEvent): void;
  getAll(): TimelineEvent[];
}

export function createBuffer(maxEvents: number, seedEvents: TimelineEvent[] = []): TimelineBuffer {
  let events: TimelineEvent[] = seedEvents.slice(-maxEvents);

  return {
    push(event: TimelineEvent) {
      events = [...events, event].slice(-maxEvents);
    },
    getAll() {
      return events;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/buffer.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/buffer.ts src/core/buffer.test.ts
git commit -m "feat(core): add TimelineEvent type and ring buffer"
```

---

### Task 3: Guardrails and redact helper

**Files:**
- Create: `src/core/guardrails.ts`
- Create: `src/core/redact.ts`
- Test: `src/core/guardrails.test.ts`
- Test: `src/core/redact.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `warnOnRiskyKeys(data: Record<string, unknown> | undefined): void`, `redact(value: unknown): string`.

- [ ] **Step 1: Write the failing tests**

`src/core/guardrails.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { warnOnRiskyKeys } from "./guardrails";

describe("warnOnRiskyKeys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when data contains a risky key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnRiskyKeys({ password: "hunter2" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("password");
  });

  it("does not warn for safe keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnRiskyKeys({ step: "shipping" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw when data is undefined", () => {
    expect(() => warnOnRiskyKeys(undefined)).not.toThrow();
  });
});
```

`src/core/redact.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("masks a string value", () => {
    expect(redact("secret@example.com")).toBe("[REDACTED]");
  });

  it("masks a non-string value", () => {
    expect(redact(12345)).toBe("[REDACTED]");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/guardrails.test.ts src/core/redact.test.ts`
Expected: FAIL — cannot find modules `./guardrails`, `./redact`.

- [ ] **Step 3: Write the implementation**

`src/core/guardrails.ts`:
```ts
const RISKY_KEYS = ["password", "token", "secret", "apiKey", "ssn", "creditCard"];

export function warnOnRiskyKeys(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (RISKY_KEYS.includes(key)) {
      console.warn(
        `[repro] event data includes a field called "${key}" — double-check this isn't sensitive before sending it.`
      );
    }
  }
}
```

`src/core/redact.ts`:
```ts
export function redact(value: unknown): string {
  return "[REDACTED]";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/guardrails.test.ts src/core/redact.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/guardrails.ts src/core/guardrails.test.ts src/core/redact.ts src/core/redact.test.ts
git commit -m "feat(core): add risky-key guardrail warning and redact() helper"
```

---

### Task 4: Payload builder

**Files:**
- Create: `src/core/payload.ts`
- Test: `src/core/payload.test.ts`

**Interfaces:**
- Consumes: `TimelineEvent`, `TimelineReason`, `TimelineMeta`, `TimelinePayload` from `src/core/types.ts` (Task 2).
- Produces: `buildPayload(sessionId: string, reason: TimelineReason, events: TimelineEvent[], meta: Omit<TimelineMeta, "capturedAt">): TimelinePayload`.

- [ ] **Step 1: Write the failing test**

`src/core/payload.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPayload } from "./payload";

describe("buildPayload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles a TimelinePayload with capturedAt set from Date.now()", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    const payload = buildPayload(
      "session-1",
      { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
      [{ timestamp: 1, type: "custom", name: "checkout.step" }],
      { url: "https://example.com/checkout", userAgent: "test-agent" }
    );

    expect(payload).toEqual({
      sessionId: "session-1",
      reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
      events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
      meta: {
        url: "https://example.com/checkout",
        userAgent: "test-agent",
        capturedAt: 1700000000000,
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/payload.test.ts`
Expected: FAIL — cannot find module `./payload`.

- [ ] **Step 3: Write the implementation**

`src/core/payload.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/payload.test.ts`
Expected: PASS — 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/payload.ts src/core/payload.test.ts
git commit -m "feat(core): add buildPayload()"
```

---

### Task 5: Core tracer

**Files:**
- Create: `src/core/tracer.ts`
- Test: `src/core/tracer.test.ts`

**Interfaces:**
- Consumes: `createBuffer` (Task 2), `buildPayload` (Task 4), `warnOnRiskyKeys` (Task 3), `TimelineEvent`/`TimelinePayload`/`TimelineMeta` (Task 2).
- Produces:
  ```ts
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
  export function createTracer(config: TracerConfig): Tracer;
  ```
  `captureError`/`captureUnhandledRejection`/`traceElement` are consumed by `browser/hooks.ts` (Task 9) — they are not part of the public package API re-exported from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

`src/core/tracer.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createTracer } from "./tracer";
import type { TimelinePayload } from "./types";

function setup() {
  const send = vi.fn<[TimelinePayload], void>();
  const getMeta = vi.fn(() => ({ url: "https://example.com", userAgent: "test-agent" }));
  const tracer = createTracer({ sessionId: "session-1", send, getMeta });
  return { send, getMeta, tracer };
}

describe("createTracer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("track() appends to the buffer without sending", () => {
    const { send, tracer } = setup();
    tracer.track("checkout.step", { step: "shipping" });
    expect(send).not.toHaveBeenCalled();
  });

  it("capture() flushes the buffer with a manual reason", () => {
    const { send, tracer } = setup();
    tracer.track("checkout.step", { step: "shipping" });
    tracer.capture("payment-declined", { code: "insufficient_funds" });

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0][0];
    expect(payload.sessionId).toBe("session-1");
    expect(payload.reason).toEqual({
      type: "manual",
      name: "payment-declined",
      data: { code: "insufficient_funds" },
    });
    expect(payload.events).toEqual([
      expect.objectContaining({ type: "custom", name: "checkout.step" }),
    ]);
  });

  it("captureError() flushes with an error reason", () => {
    const { send, tracer } = setup();
    tracer.captureError("Cannot read properties of undefined");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].reason).toEqual({
      type: "error",
      message: "Cannot read properties of undefined",
    });
  });

  it("captureUnhandledRejection() flushes with an unhandledrejection reason", () => {
    const { send, tracer } = setup();
    tracer.captureUnhandledRejection("network request failed");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].reason).toEqual({
      type: "unhandledrejection",
      message: "network request failed",
    });
  });

  it("traceElement() appends a trace-typed event to the buffer without sending", () => {
    const { send, tracer } = setup();
    tracer.traceElement("Sign up form submit");
    expect(send).not.toHaveBeenCalled();

    tracer.capture();
    expect(send.mock.calls[0][0].events).toEqual([
      expect.objectContaining({ type: "trace", name: "Sign up form submit" }),
    ]);
  });

  it("calls onBufferChange with the full buffer after every track() and traceElement()", () => {
    const onBufferChange = vi.fn();
    const tracer = createTracer({
      sessionId: "session-1",
      send: vi.fn(),
      getMeta: () => ({ url: "https://example.com", userAgent: "test-agent" }),
      onBufferChange,
    });

    tracer.track("checkout.step");
    expect(onBufferChange).toHaveBeenCalledOnce();
    expect(onBufferChange.mock.calls[0][0]).toHaveLength(1);

    tracer.traceElement("Sign up button");
    expect(onBufferChange).toHaveBeenCalledTimes(2);
    expect(onBufferChange.mock.calls[1][0]).toHaveLength(2);
  });

  it("warns via console.warn when track() data has a risky key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tracer } = setup();
    tracer.track("login", { password: "hunter2" });
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/tracer.test.ts`
Expected: FAIL — cannot find module `./tracer`.

- [ ] **Step 3: Write the implementation**

`src/core/tracer.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/tracer.test.ts`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/tracer.ts src/core/tracer.test.ts
git commit -m "feat(core): add createTracer() — track/capture/error hooks/trace"
```

---

### Task 6: Browser environment guard

**Files:**
- Create: `src/browser/env.ts`
- Test: `src/browser/env.test.ts`
- Test: `src/browser/env.jsdom.test.ts`

**Interfaces:**
- Produces: `isBrowserEnvironment(): boolean`.

- [ ] **Step 1: Write the failing tests**

`src/browser/env.test.ts` (default node environment — no `window`):
```ts
import { describe, it, expect } from "vitest";
import { isBrowserEnvironment } from "./env";

describe("isBrowserEnvironment (node)", () => {
  it("returns false when window/document are unavailable", () => {
    expect(isBrowserEnvironment()).toBe(false);
  });
});
```

`src/browser/env.jsdom.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { isBrowserEnvironment } from "./env";

describe("isBrowserEnvironment (jsdom)", () => {
  it("returns true when window/document are available", () => {
    expect(isBrowserEnvironment()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/env.test.ts src/browser/env.jsdom.test.ts`
Expected: FAIL — cannot find module `./env`.

- [ ] **Step 3: Write the implementation**

`src/browser/env.ts`:
```ts
export function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/env.test.ts src/browser/env.jsdom.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/env.ts src/browser/env.test.ts src/browser/env.jsdom.test.ts
git commit -m "feat(browser): add isBrowserEnvironment() guard"
```

---

### Task 7: sessionStorage-backed persistence

**Files:**
- Create: `src/browser/storage.ts`
- Test: `src/browser/storage.test.ts`

**Interfaces:**
- Consumes: `TimelineEvent` (Task 2).
- Produces: `readBuffer(): TimelineEvent[] | undefined`, `writeBuffer(events: TimelineEvent[]): void`, `readSessionId(): string | undefined`, `writeSessionId(id: string): void`.

- [ ] **Step 1: Write the failing test**

`src/browser/storage.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readBuffer, writeBuffer, readSessionId, writeSessionId } from "./storage";

describe("browser storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips the buffer through sessionStorage", () => {
    expect(readBuffer()).toBeUndefined();
    writeBuffer([{ timestamp: 1, type: "custom", name: "a" }]);
    expect(readBuffer()).toEqual([{ timestamp: 1, type: "custom", name: "a" }]);
  });

  it("round-trips the session id through sessionStorage", () => {
    expect(readSessionId()).toBeUndefined();
    writeSessionId("session-1");
    expect(readSessionId()).toBe("session-1");
  });

  it("does not throw when sessionStorage.setItem fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeBuffer([{ timestamp: 1, type: "custom", name: "a" }])).not.toThrow();
    expect(() => writeSessionId("session-1")).not.toThrow();
  });

  it("does not throw and returns undefined when sessionStorage.getItem fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readBuffer()).toBeUndefined();
    expect(readSessionId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser/storage.test.ts`
Expected: FAIL — cannot find module `./storage`.

- [ ] **Step 3: Write the implementation**

`src/browser/storage.ts`:
```ts
import type { TimelineEvent } from "../core/types";

const BUFFER_KEY = "__repro_buffer";
const SESSION_ID_KEY = "__repro_session_id";

export function readBuffer(): TimelineEvent[] | undefined {
  try {
    const raw = sessionStorage.getItem(BUFFER_KEY);
    return raw ? (JSON.parse(raw) as TimelineEvent[]) : undefined;
  } catch {
    return undefined;
  }
}

export function writeBuffer(events: TimelineEvent[]): void {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify(events));
  } catch {
    // best-effort persistence only
  }
}

export function readSessionId(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_ID_KEY, id);
  } catch {
    // best-effort persistence only
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browser/storage.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/storage.ts src/browser/storage.test.ts
git commit -m "feat(browser): add sessionStorage-backed buffer/session persistence"
```

---

### Task 8: Session ID generation

**Files:**
- Create: `src/browser/sessionId.ts`
- Test: `src/browser/sessionId.test.ts`

**Interfaces:**
- Consumes: `readSessionId`, `writeSessionId` (Task 7).
- Produces: `getOrCreateSessionId(): string`.

- [ ] **Step 1: Write the failing test**

`src/browser/sessionId.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateSessionId } from "./sessionId";

describe("getOrCreateSessionId", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("generates and persists a session id on first call", () => {
    const id = getOrCreateSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem("__repro_session_id")).toBe(id);
  });

  it("returns the same id on subsequent calls", () => {
    const first = getOrCreateSessionId();
    const second = getOrCreateSessionId();
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser/sessionId.test.ts`
Expected: FAIL — cannot find module `./sessionId`.

- [ ] **Step 3: Write the implementation**

`src/browser/sessionId.ts`:
```ts
import { readSessionId, writeSessionId } from "./storage";

export function getOrCreateSessionId(): string {
  const existing = readSessionId();
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeSessionId(id);
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browser/sessionId.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sessionId.ts src/browser/sessionId.test.ts
git commit -m "feat(browser): add getOrCreateSessionId()"
```

---

### Task 9: Fetch transport

**Files:**
- Create: `src/browser/transport.ts`
- Test: `src/browser/transport.test.ts`

**Interfaces:**
- Consumes: `TimelinePayload` (Task 2).
- Produces: `createSend(endpoint: string, apiKey: string): (payload: TimelinePayload) => void`.

- [ ] **Step 1: Write the failing test**

`src/browser/transport.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSend } from "./transport";
import type { TimelinePayload } from "../core/types";

const payload: TimelinePayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined" },
  events: [],
  meta: { url: "https://example.com", userAgent: "test-agent", capturedAt: 1 },
};

describe("createSend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("POSTs the payload with keepalive and the api key header", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createSend("https://ingest.example.com/timeline", "key-123");
    send(payload);

    expect(fetchMock).toHaveBeenCalledWith("https://ingest.example.com/timeline", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Repro-Key": "key-123",
      },
      body: JSON.stringify(payload),
    });
  });

  it("warns via console.warn instead of throwing when fetch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    const send = createSend("https://ingest.example.com/timeline", "key-123");
    expect(() => send(payload)).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser/transport.test.ts`
Expected: FAIL — cannot find module `./transport`.

- [ ] **Step 3: Write the implementation**

`src/browser/transport.ts`:
```ts
import type { TimelinePayload } from "../core/types";

export function createSend(endpoint: string, apiKey: string): (payload: TimelinePayload) => void {
  return (payload: TimelinePayload) => {
    fetch(endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Repro-Key": apiKey,
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      console.warn("[repro] failed to send timeline:", error);
    });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browser/transport.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/transport.ts src/browser/transport.test.ts
git commit -m "feat(browser): add fetch keepalive transport"
```

---

### Task 10: DOM hooks (auto errors + data-trace)

**Files:**
- Create: `src/browser/hooks.ts`
- Test: `src/browser/hooks.test.ts`

**Interfaces:**
- Consumes: `Tracer` type (Task 5) — specifically calls `captureError`, `captureUnhandledRejection`, `traceElement`.
- Produces: `attachErrorHooks(tracer: Tracer): () => void`, `attachTraceAttributeListener(tracer: Tracer): () => void`. Both return a `dispose` function.

- [ ] **Step 1: Write the failing test**

`src/browser/hooks.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { attachErrorHooks, attachTraceAttributeListener } from "./hooks";
import type { Tracer } from "../core/tracer";

function fakeTracer(): Tracer {
  return {
    track: vi.fn(),
    capture: vi.fn(),
    captureError: vi.fn(),
    captureUnhandledRejection: vi.fn(),
    traceElement: vi.fn(),
  };
}

describe("attachErrorHooks", () => {
  it("calls captureError on a window error event", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(tracer.captureError).toHaveBeenCalledWith("boom");
  });

  it("calls captureUnhandledRejection on an unhandledrejection event", () => {
    const tracer = fakeTracer();
    attachErrorHooks(tracer);

    const event = Object.assign(new Event("unhandledrejection"), { reason: "network down" });
    window.dispatchEvent(event);

    expect(tracer.captureUnhandledRejection).toHaveBeenCalledWith("network down");
  });

  it("stops calling the tracer after dispose()", () => {
    const tracer = fakeTracer();
    const dispose = attachErrorHooks(tracer);
    dispose();

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(tracer.captureError).not.toHaveBeenCalled();
  });
});

describe("attachTraceAttributeListener", () => {
  it("calls traceElement with the data-trace value on click", () => {
    document.body.innerHTML = '<button data-trace="Sign up submit"><span>Sign up</span></button>';
    const tracer = fakeTracer();
    attachTraceAttributeListener(tracer);

    document.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).toHaveBeenCalledWith("Sign up submit");
  });

  it("does not call traceElement for clicks outside a data-trace element", () => {
    document.body.innerHTML = "<button>No trace</button>";
    const tracer = fakeTracer();
    attachTraceAttributeListener(tracer);

    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).not.toHaveBeenCalled();
  });

  it("stops calling the tracer after dispose()", () => {
    document.body.innerHTML = '<button data-trace="Sign up submit">Sign up</button>';
    const tracer = fakeTracer();
    const dispose = attachTraceAttributeListener(tracer);
    dispose();

    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(tracer.traceElement).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser/hooks.test.ts`
Expected: FAIL — cannot find module `./hooks`.

- [ ] **Step 3: Write the implementation**

`src/browser/hooks.ts`:
```ts
import type { Tracer } from "../core/tracer";

export function attachErrorHooks(tracer: Tracer): () => void {
  function onError(event: ErrorEvent): void {
    tracer.captureError(event.message);
  }
  function onRejection(event: PromiseRejectionEvent): void {
    tracer.captureUnhandledRejection(String(event.reason));
  }
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

const TRACE_ATTRIBUTE = "data-trace";

export function attachTraceAttributeListener(tracer: Tracer): () => void {
  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    const el = target?.closest(`[${TRACE_ATTRIBUTE}]`);
    if (!el) return;
    const label = el.getAttribute(TRACE_ATTRIBUTE);
    if (label) tracer.traceElement(label);
  }
  document.addEventListener("click", onClick, { capture: true });
  return () => {
    document.removeEventListener("click", onClick, { capture: true });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browser/hooks.test.ts`
Expected: PASS — 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/hooks.ts src/browser/hooks.test.ts
git commit -m "feat(browser): add auto error hooks and data-trace click listener"
```

---

### Task 11: Browser tracer factory (wiring)

**Files:**
- Create: `src/browser/createTracer.ts`
- Test: `src/browser/createTracer.test.ts`
- Test: `src/browser/createTracer.node.test.ts`

**Interfaces:**
- Consumes: `createTracer` from `src/core/tracer.ts` (Task 5, imported as `createCoreTracer`), `getOrCreateSessionId` (Task 8), `readBuffer`/`writeBuffer` (Task 7), `createSend` (Task 9), `attachErrorHooks`/`attachTraceAttributeListener` (Task 10), `isBrowserEnvironment` (Task 6), `TimelineEvent` (Task 2).
- Produces:
  ```ts
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
  export function createTracer(config: CreateTracerConfig): BrowserTracer;
  ```
  Consumed by `src/index.ts` (Task 12).

- [ ] **Step 1: Write the failing tests**

`src/browser/createTracer.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTracer } from "./createTracer";

describe("browser createTracer", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("generates and persists a session id on creation", () => {
    createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    expect(sessionStorage.getItem("__repro_session_id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("track() then capture() sends a payload via fetch", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.track("checkout.step", { step: "shipping" });
    tracer.capture("payment-declined");

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reason).toEqual({ type: "manual", name: "payment-declined" });
    expect(body.events).toEqual([
      expect.objectContaining({ type: "custom", name: "checkout.step" }),
    ]);
  });

  it("auto-flushes on a window error event by default", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not auto-flush on error when captureErrors is false", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    createTracer({
      endpoint: "https://ingest.example.com/timeline",
      apiKey: "key-123",
      captureErrors: false,
    });
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispose() stops the auto error hook", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.dispose();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists tracked events to sessionStorage for reload rehydration", () => {
    const tracer = createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.track("checkout.step", { step: "shipping" });

    const persisted = JSON.parse(sessionStorage.getItem("__repro_buffer")!);
    expect(persisted).toEqual([expect.objectContaining({ type: "custom", name: "checkout.step" })]);
  });
});
```

`src/browser/createTracer.node.test.ts` (default node environment — no `window`/`document`):
```ts
import { describe, it, expect } from "vitest";
import { createTracer } from "./createTracer";

describe("browser createTracer (non-browser environment)", () => {
  it("returns a no-op tracer instead of throwing", () => {
    const tracer = createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    expect(() => tracer.track("checkout.step")).not.toThrow();
    expect(() => tracer.capture("payment-declined")).not.toThrow();
    expect(() => tracer.dispose()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/createTracer.test.ts src/browser/createTracer.node.test.ts`
Expected: FAIL — cannot find module `./createTracer`.

- [ ] **Step 3: Write the implementation**

`src/browser/createTracer.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/createTracer.test.ts src/browser/createTracer.node.test.ts`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/browser/createTracer.ts src/browser/createTracer.test.ts src/browser/createTracer.node.test.ts
git commit -m "feat(browser): wire core tracer to DOM hooks, storage, and transport"
```

---

### Task 12: Public entry point

**Files:**
- Modify: `src/index.ts` (replaces the Task 1 placeholder)
- Modify: `src/index.test.ts` (replaces the Task 1 smoke test)

**Interfaces:**
- Consumes: `createTracer`, `CreateTracerConfig` (Task 11), `redact` (Task 3), `TimelineEvent`/`TimelinePayload`/`TimelineReason`/`TimelineMeta` (Task 2).
- Produces: `init(config: CreateTracerConfig): { dispose: () => void }`, `track(name: string, data?: Record<string, unknown>): void`, `capture(name?: string, data?: Record<string, unknown>): void`, re-exports `createTracer`, `redact`, and the core types.

- [ ] **Step 1: Write the failing test**

Replace `src/index.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const trackMock = vi.fn();
const captureMock = vi.fn();
const disposeMock = vi.fn();
const createTracerMock = vi.fn(() => ({
  track: trackMock,
  capture: captureMock,
  dispose: disposeMock,
}));

vi.mock("./browser/createTracer", () => ({
  createTracer: createTracerMock,
}));

describe("public entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and no-ops if track()/capture() are called before init()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { track, capture } = await import("./index");

    track("checkout.step");
    capture("payment-declined");

    expect(trackMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("delegates track()/capture() to the created tracer after init()", async () => {
    const { init, track, capture } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    track("checkout.step", { step: "shipping" });
    capture("payment-declined");

    expect(trackMock).toHaveBeenCalledWith("checkout.step", { step: "shipping" });
    expect(captureMock).toHaveBeenCalledWith("payment-declined", undefined);
  });

  it("disposes the previous instance and warns when init() is called twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { init } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-456" });

    expect(disposeMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(createTracerMock).toHaveBeenCalledTimes(2);
  });

  it("init() returns a dispose() that tears down the instance", async () => {
    const { init, track } = await import("./index");

    const handle = init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    handle.dispose();

    expect(disposeMock).toHaveBeenCalledOnce();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    track("checkout.step");
    expect(trackMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — `init`/`track`/`capture` are not exported from `./index` yet (current `index.ts` only exports `VERSION`).

- [ ] **Step 3: Write the implementation**

Replace `src/index.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests across every file pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add public entry point (init/track/capture)"
```

---

### Task 13: React ErrorBoundary adapter

**Files:**
- Create: `src/react/ErrorBoundary.tsx`
- Create: `src/react/index.ts`
- Test: `src/react/ErrorBoundary.test.tsx`
- Modify: `package.json` (add `./react` export, `react` peer dependency, test dependencies)
- Modify: `tsup.config.ts` (add `react` build entry)

**Interfaces:**
- Consumes: `capture` from `src/index.ts` (Task 12).
- Produces: `ErrorBoundary` React component, `ErrorBoundaryProps`, exported from `@repro/js/react`.

- [ ] **Step 1: Add test dependencies and configure the `./react` export**

Modify `package.json`: add to `"exports"`:
```json
    "./react": {
      "types": "./dist/react.d.ts",
      "import": "./dist/react.js",
      "require": "./dist/react.cjs"
    }
```

Add `"peerDependencies"` and `"peerDependenciesMeta"`:
```json
  "peerDependencies": {
    "react": ">=17"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  },
```

Add to `"devDependencies"`:
```json
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@testing-library/react": "^16.0.0"
```

Run: `npm install`
Expected: installs without error.

- [ ] **Step 2: Write the failing test**

`src/react/ErrorBoundary.test.tsx`:
```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

const captureMock = vi.fn();
vi.mock("../index", () => ({
  capture: (...args: unknown[]) => captureMock(...args),
}));

function Boom(): never {
  throw new Error("render blew up");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("calls capture() with the error message and renders the fallback on error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<p>something broke</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText("something broke")).toBeTruthy();
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock.mock.calls[0][0]).toBe("render blew up");

    consoleError.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/react/ErrorBoundary.test.tsx`
Expected: FAIL — cannot find module `./ErrorBoundary`.

- [ ] **Step 4: Write the implementation**

`src/react/ErrorBoundary.tsx`:
```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { capture } from "../index";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    capture(error.message, { componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
```

`src/react/index.ts`:
```ts
export { ErrorBoundary } from "./ErrorBoundary";
export type { ErrorBoundaryProps } from "./ErrorBoundary";
```

Modify `tsup.config.ts` — update the `entry` map:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/react/ErrorBoundary.test.tsx`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsup.config.ts src/react/ErrorBoundary.tsx src/react/index.ts src/react/ErrorBoundary.test.tsx
git commit -m "feat(react): add ErrorBoundary adapter, exported via @repro/js/react"
```

---

### Task 14: Full build verification and lint boundary check

**Files:**
- Create: `src/dist-smoke.test.ts` (temporary-in-spirit but kept as a permanent regression test)
- No other files modified (this task verifies the whole package, it doesn't add features).

**Interfaces:**
- Consumes: the built `dist/index.js` and `dist/react.js` output of the whole package.

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`
Expected: PASS — every test file across `core/`, `browser/`, `react/`, and `index.test.ts` passes.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: creates `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/react.js`, `dist/react.cjs`, `dist/react.d.ts`.

- [ ] **Step 3: Write a smoke test against the built output**

`src/dist-smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as pkg from "../dist/index.js";
import * as reactPkg from "../dist/react.js";

describe("built package exports", () => {
  it("exposes the public API from the built entry point", () => {
    expect(typeof pkg.init).toBe("function");
    expect(typeof pkg.track).toBe("function");
    expect(typeof pkg.capture).toBe("function");
    expect(typeof pkg.createTracer).toBe("function");
    expect(typeof pkg.redact).toBe("function");
  });

  it("exposes ErrorBoundary from the built react entry point", () => {
    expect(typeof reactPkg.ErrorBoundary).toBe("function");
  });
});
```

Run: `npx vitest run src/dist-smoke.test.ts`
Expected: PASS — 2 tests passed. (If it fails, re-check Step 2's build output and the `package.json` `exports` map from Task 13 Step 1.)

- [ ] **Step 4: Verify the ESLint core/browser boundary rule actually fires**

Temporarily add a bad import to the top of `src/core/buffer.ts`:
```ts
import "../browser/storage";
```

Run: `npm run lint`
Expected: FAIL — error from `import/no-restricted-paths` naming `src/core/buffer.ts` and the message "core/ must stay environment-agnostic — it cannot import from browser/."

Remove the line you just added from `src/core/buffer.ts`, restoring it to the Task 2 version.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/dist-smoke.test.ts
git commit -m "test: verify built package exports and core/browser lint boundary"
```
