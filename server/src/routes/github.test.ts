import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestOrg, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { createInvite } from "../db/invites";
import { addMember, listUserOrgs } from "../db/orgs";
import { findUserByEmail, findUserByGithubId, findUserById } from "../db/users";
import type { AppOptions } from "../app";

const GITHUB = { clientId: "cid", clientSecret: "secret", baseUrl: "https://github.com" };

interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
  tokenFails?: boolean;
}

function fakeGithub(user: FakeGithubUser): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return json(user.tokenFails ? { error: "bad_verification_code" } : { access_token: "gho_test" });
    }
    if (url === "https://api.github.com/user") return json({ id: user.id, login: user.login, name: user.name });
    if (url === "https://api.github.com/user/emails") return json(user.emails);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const ANA: FakeGithubUser = {
  id: 42,
  login: "ana",
  name: "Ana",
  emails: [{ email: "ana@example.com", primary: true, verified: true }],
};

async function githubApp(user: FakeGithubUser, options: AppOptions = {}) {
  return buildTestApp(getTestDb(), { github: GITHUB, githubFetch: fakeGithub(user), ...options });
}

// Runs the whole round trip: start → (GitHub) → callback. Returns the callback response.
async function oauthRoundTrip(app: FastifyInstance, query = "intent=login", cookie?: string) {
  const start = await call(app, "GET", `/api/auth/github?${query}`, { cookie });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const oauth = start.cookies.find((c) => c.name === "tripcord_oauth");
  const cookies = [`tripcord_oauth=${oauth!.value}`, cookie].filter(Boolean).join("; ");
  return call(app, "GET", `/api/auth/github/callback?code=abc&state=${state}`, { cookie: cookies });
}

describe("GitHub OAuth", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("is 404 when GitHub isn't configured", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "GET", "/api/auth/github?intent=login")).statusCode).toBe(404);
  });

  it("redirects to GitHub with a state bound to an httpOnly cookie", async () => {
    const app = await githubApp(ANA);
    const response = await call(app, "GET", "/api/auth/github?intent=login");

    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${TEST_ORIGIN}/api/auth/github/callback`);
    const oauth = response.cookies.find((c) => c.name === "tripcord_oauth");
    expect(oauth).toMatchObject({ httpOnly: true, path: "/api/auth/github" });
    expect(oauth!.value.startsWith(location.searchParams.get("state")!)).toBe(true);
  });

  it("signs up a new user with no password and logs them in", async () => {
    const app = await githubApp(ANA, { signup: "open" });

    const response = await oauthRoundTrip(app);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.cookies.find((c) => c.name === "tripcord_session")?.value).toBeTruthy();
    const user = await findUserByGithubId(getTestDb(), "42");
    expect(user).toMatchObject({ email: "ana@example.com", name: "Ana", passwordHash: null });
    expect((await listUserOrgs(getTestDb(), user!.id)).map((o) => o.name)).toEqual(["Ana's org"]);
  });

  it("strips control characters from the GitHub profile name", async () => {
    const app = await githubApp({ ...ANA, name: "\x1b[31mAna\n" }, { signup: "open" });
    await oauthRoundTrip(app);
    expect((await findUserByGithubId(getTestDb(), "42"))?.name).toBe("[31mAna");
  });

  it("logs in an already-linked user without creating anyone", async () => {
    const existing = await createTestUser(getTestDb(), { email: "other@example.com", githubId: "42" });
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app);

    expect(response.headers.location).toBe("/");
    expect(response.cookies.find((c) => c.name === "tripcord_session")).toBeDefined();
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeUndefined();
    expect((await findUserById(getTestDb(), existing.id))?.githubId).toBe("42");
  });

  it("refuses to auto-link to a password account with the same email", async () => {
    const existing = await createTestUser(getTestDb(), { email: "ana@example.com" });
    const app = await githubApp(ANA, { signup: "open" });

    const response = await oauthRoundTrip(app);

    expect(response.headers.location).toBe("/login?error=github_email_exists");
    expect((await findUserById(getTestDb(), existing.id))?.githubId).toBeNull();
  });

  it("refuses a GitHub account without a verified primary email", async () => {
    const app = await githubApp(
      { ...ANA, emails: [{ email: "ana@example.com", primary: true, verified: false }] },
      { signup: "open" }
    );
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=github_no_email");
  });

  it("rejects a callback whose state doesn't match the cookie", async () => {
    const app = await githubApp(ANA);
    const response = await call(app, "GET", "/api/auth/github/callback?code=abc&state=forged", {
      cookie: "tripcord_oauth=real.login.",
    });
    expect(response.headers.location).toBe("/login?error=github_state");
  });

  it("reports a failed token exchange", async () => {
    const app = await githubApp({ ...ANA, tokenFails: true });
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=github_failed");
  });

  it("applies invite-only signup rules, and honors an invite", async () => {
    await createTestUser(getTestDb()); // instance already bootstrapped
    const app = await githubApp(ANA);
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=signup_closed");

    const org = await createTestOrg(getTestDb(), "Acme");
    const owner = await createTestUser(getTestDb());
    await addMember(getTestDb(), org.id, owner.id, "owner");
    const { token } = await createInvite(getTestDb(), { orgId: org.id, role: "member", createdBy: owner.id });

    const response = await oauthRoundTrip(app, `intent=login&invite=${token}`);

    expect(response.headers.location).toBe("/");
    const user = await findUserByGithubId(getTestDb(), "42");
    expect(await listUserOrgs(getTestDb(), user!.id)).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
  });

  it("connects GitHub to the logged-in user", async () => {
    const user = await createTestUser(getTestDb(), { email: "someone@example.com" });
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app, "intent=connect", await sessionCookie(getTestDb(), user.id));

    expect(response.headers.location).toBe("/settings");
    expect((await findUserById(getTestDb(), user.id))?.githubId).toBe("42");
  });

  it("won't connect a GitHub account that belongs to another user", async () => {
    await createTestUser(getTestDb(), { githubId: "42" });
    const user = await createTestUser(getTestDb());
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app, "intent=connect", await sessionCookie(getTestDb(), user.id));

    expect(response.headers.location).toBe("/settings?error=github_taken");
    expect((await findUserById(getTestDb(), user.id))?.githubId).toBeNull();
  });

  it("sends a logged-out connect attempt to the login page", async () => {
    const app = await githubApp(ANA);
    expect((await oauthRoundTrip(app, "intent=connect")).headers.location).toBe("/login?error=not_logged_in");
  });
});
