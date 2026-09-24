import { describe, it, expect } from "vitest";
import { passwordResetMail, signupInviteMail, verifyEmailMail } from "./email";

describe("messages", () => {
  it("password reset: one link, its expiry, and what to do if unexpected", () => {
    const mail = passwordResetMail("ana@example.com", "Ana", "https://app.tripcord.dev/reset-password/tpr_x");
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe("Reset your Tripcord password");
    expect(mail.text).toContain("Hi Ana,");
    expect(mail.text).toContain("https://app.tripcord.dev/reset-password/tpr_x");
    expect(mail.text).toContain("one hour");
    expect(mail.text).toContain("didn't ask");
  });

  it("signup invite: the link and the expiry date", () => {
    const mail = signupInviteMail("neo@example.com", "https://app.tripcord.dev/invite/tpi_x", new Date("2026-10-01T12:00:00Z"));
    expect(mail.subject).toBe("You're invited to Tripcord");
    expect(mail.text).toContain("https://app.tripcord.dev/invite/tpi_x");
    expect(mail.text).toContain("2026-10-01");
  });

  it("email verification: the link, its expiry, and what happens if unexpected", () => {
    const mail = verifyEmailMail("ana@example.com", "Ana", "https://app.tripcord.dev/verify-email/tpv_x");
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe("Confirm your Tripcord email");
    expect(mail.text).toContain("Hi Ana,");
    expect(mail.text).toContain("https://app.tripcord.dev/verify-email/tpv_x");
    expect(mail.text).toContain("24 hours");
    expect(mail.text).toContain("deleted in 7 days");
  });
});
