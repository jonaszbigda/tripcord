import { describe, it, expect } from "vitest";
import { loadDashboardConfig } from "./config";

describe("loadDashboardConfig", () => {
  it("applies defaults", () => {
    expect(loadDashboardConfig({}, "/default/dist")).toEqual({
      publicUrl: "http://localhost:3000",
      signup: "invite-only",
      github: undefined,
      trustProxy: false,
      dashboardDir: "/default/dist",
      email: undefined,
    });
  });

  it("reads every variable", () => {
    const config = loadDashboardConfig(
      {
        PUBLIC_URL: "https://app.tripcord.dev/",
        SIGNUP: "open",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_BASE_URL: "https://ghe.example.com",
        TRUST_PROXY: "true",
        DASHBOARD_DIR: "/srv/dashboard",
        SMTP_URL: "smtps://u:p@smtp.example.com:465",
        EMAIL_FROM: "Tripcord <no-reply@tripcord.dev>",
      },
      "/default/dist"
    );
    expect(config).toEqual({
      publicUrl: "https://app.tripcord.dev",
      signup: "open",
      github: { clientId: "id", clientSecret: "secret", baseUrl: "https://ghe.example.com" },
      trustProxy: true,
      dashboardDir: "/srv/dashboard",
      email: { smtpUrl: "smtps://u:p@smtp.example.com:465", from: "Tripcord <no-reply@tripcord.dev>" },
    });
  });

  it("requires SMTP_URL and EMAIL_FROM together", () => {
    expect(() => loadDashboardConfig({ SMTP_URL: "smtp://localhost" }, "/d")).toThrow(
      "SMTP_URL and EMAIL_FROM must be set together"
    );
    expect(() => loadDashboardConfig({ EMAIL_FROM: "a@b.c" }, "/d")).toThrow(
      "SMTP_URL and EMAIL_FROM must be set together"
    );
  });

  it("rejects an SMTP_URL that isn't smtp:// or smtps://", () => {
    expect(() => loadDashboardConfig({ SMTP_URL: "https://mail.example.com", EMAIL_FROM: "a@b.c" }, "/d")).toThrow(
      "SMTP_URL must start with smtp:// or smtps://"
    );
  });

  it("defaults the GitHub base URL", () => {
    const config = loadDashboardConfig({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }, "/d");
    expect(config.github?.baseUrl).toBe("https://github.com");
  });

  it.each([
    [{ SIGNUP: "closed" }, 'SIGNUP must be "open" or "invite-only"'],
    [{ GITHUB_CLIENT_ID: "id" }, "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together"],
    [{ GITHUB_CLIENT_SECRET: "s" }, "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together"],
    [{ PUBLIC_URL: "app.tripcord.dev" }, "PUBLIC_URL must be an absolute http(s) URL"],
    [{ PUBLIC_URL: "ftp://x.dev" }, "PUBLIC_URL must be an absolute http(s) URL"],
  ])("rejects %o", (env, message) => {
    expect(() => loadDashboardConfig(env, "/d")).toThrow(message);
  });
});
