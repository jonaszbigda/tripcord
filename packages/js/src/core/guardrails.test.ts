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
