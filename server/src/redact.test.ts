import { describe, it, expect } from "vitest";
import { redactTokens } from "./redact";

describe("redactTokens", () => {
  it("hides invite, reset and key tokens, keeping their prefix", () => {
    expect(redactTokens("/api/invites/tpi_abc-DEF_123/accept")).toBe("/api/invites/tpi_[redacted]/accept");
    expect(redactTokens("/reset-password/tpr_abc")).toBe("/reset-password/tpr_[redacted]");
    expect(redactTokens("/x?key=tpk_abc&y=1")).toBe("/x?key=tpk_[redacted]&y=1");
  });

  it("leaves other URLs alone", () => {
    expect(redactTokens("/api/orgs/1/projects")).toBe("/api/orgs/1/projects");
  });
});
