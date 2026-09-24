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

  it("returns undefined without throwing when the stored buffer JSON is not an array", () => {
    sessionStorage.setItem("__tripcord_buffer", "{}");
    expect(() => readBuffer()).not.toThrow();
    expect(readBuffer()).toBeUndefined();
  });
});
