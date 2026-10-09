import { describe, it, expect, vi, afterEach } from "vitest";
import { randomId } from "./ids";

describe("randomId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a v4-shaped id", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns distinct ids", () => {
    expect(randomId()).not.toBe(randomId());
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
});
