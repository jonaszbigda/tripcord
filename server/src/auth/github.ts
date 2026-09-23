import type { GithubConfig } from "../config";

export interface GithubProfile {
  /** GitHub's numeric user id, as text. */
  id: string;
  login: string;
  name: string | null;
  /** The verified primary email, or null if GitHub has none verified. */
  email: string | null;
}

export class GithubError extends Error {}

export function githubApiBase(baseUrl: string): string {
  return baseUrl === "https://github.com" ? "https://api.github.com" : `${baseUrl}/api/v3`;
}

export function githubAuthorizeUrl(config: GithubConfig, state: string, redirectUri: string): string {
  const url = new URL("/login/oauth/authorize", config.baseUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
  }).toString();
  return url.toString();
}

export async function fetchGithubProfile(
  config: GithubConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch
): Promise<GithubProfile> {
  const tokenResponse = await fetchImpl(new URL("/login/oauth/access_token", config.baseUrl).toString(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  // GitHub reports a bad code as 200 with `{ error }`, so check the body too.
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new GithubError("GitHub token exchange failed");
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tokenBody.access_token}`,
    "User-Agent": "repro",
  };
  const api = githubApiBase(config.baseUrl);
  const [userResponse, emailsResponse] = await Promise.all([
    fetchImpl(`${api}/user`, { headers }),
    fetchImpl(`${api}/user/emails`, { headers }),
  ]);
  if (!userResponse.ok || !emailsResponse.ok) {
    throw new GithubError("GitHub API request failed");
  }
  const user = (await userResponse.json()) as { id: number; login: string; name: string | null };
  const emails = (await emailsResponse.json()) as { email: string; primary: boolean; verified: boolean }[];
  const primary = emails.find((e) => e.primary && e.verified);
  return { id: String(user.id), login: user.login, name: user.name, email: primary?.email ?? null };
}
