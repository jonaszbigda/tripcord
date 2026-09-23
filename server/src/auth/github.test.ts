import { describe, it, expect } from "vitest";
import { fetchGithubProfile, githubApiBase, githubAuthorizeUrl, GithubError } from "./github";

const config = { clientId: "cid", clientSecret: "secret", baseUrl: "https://github.com" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("github helpers", () => {
  it("derives the API base for github.com and GitHub Enterprise Server", () => {
    expect(githubApiBase("https://github.com")).toBe("https://api.github.com");
    expect(githubApiBase("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
  });

  it("builds the authorize URL", () => {
    const url = new URL(githubAuthorizeUrl(config, "st4te", "http://localhost:3000/api/auth/github/callback"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "http://localhost:3000/api/auth/github/callback",
      scope: "read:user user:email",
      state: "st4te",
    });
  });

  it("exchanges the code and returns the profile with the verified primary email", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_x" });
      if (url === "https://api.github.com/user") return json({ id: 42, login: "ana", name: "Ana" });
      return json([
        { email: "old@example.com", primary: false, verified: true },
        { email: "Ana@Example.com", primary: true, verified: true },
      ]);
    }) as typeof fetch;

    const profile = await fetchGithubProfile(config, "code", "http://cb", fetchImpl);

    expect(profile).toEqual({ id: "42", login: "ana", name: "Ana", email: "Ana@Example.com" });
    expect(calls).toContain("https://api.github.com/user/emails");
  });

  it("returns a null email when the primary email is unverified", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("access_token")) return json({ access_token: "gho_x" });
      if (url.endsWith("/user")) return json({ id: 1, login: "x", name: null });
      return json([{ email: "x@example.com", primary: true, verified: false }]);
    }) as typeof fetch;

    expect((await fetchGithubProfile(config, "code", "http://cb", fetchImpl)).email).toBeNull();
  });

  it("throws GithubError when the token exchange fails", async () => {
    const fetchImpl = (async () => json({ error: "bad_verification_code" })) as typeof fetch;
    await expect(fetchGithubProfile(config, "code", "http://cb", fetchImpl)).rejects.toBeInstanceOf(GithubError);
  });
});
