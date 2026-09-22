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
