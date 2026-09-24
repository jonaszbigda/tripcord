/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getOrCreateSessionId } from "./sessionId";

describe("getOrCreateSessionId", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates and persists a session id on first call", () => {
    const id = getOrCreateSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem("__tripcord_session_id")).toBe(id);
  });

  it("returns the same id on subsequent calls", () => {
    const first = getOrCreateSessionId();
    const second = getOrCreateSessionId();
    expect(second).toBe(first);
  });

  it("falls back to a manual UUID v4 generator when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", { ...crypto, randomUUID: undefined });

    let id: string | undefined;
    expect(() => {
      id = getOrCreateSessionId();
    }).not.toThrow();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionStorage.getItem("__tripcord_session_id")).toBe(id);
  });
});
