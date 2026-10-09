import { describe, it, expect } from "vitest";
import { parseDurationMs } from "./duration";

describe("parseDurationMs", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["15m", 900_000],
    ["24h", 86_400_000],
    ["7d", 604_800_000],
    [" 24h ", 86_400_000],
  ])("parses %j", (value, expected) => {
    expect(parseDurationMs(value)).toBe(expected);
  });

  it.each(["", "24", "h", "24 hours", "-1h", "1.5h"])("rejects %j", (value) => {
    expect(() => parseDurationMs(value)).toThrow(/Invalid duration/);
  });
});
