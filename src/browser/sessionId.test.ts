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
