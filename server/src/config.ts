import { SIGNUP_MODES, type SignupMode } from "./accounts";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** github.com or a GitHub Enterprise Server origin. */
  baseUrl: string;
}

export interface DashboardConfig {
  publicUrl: string;
  signup: SignupMode;
  github?: GithubConfig;
  trustProxy: boolean;
  dashboardDir: string;
}

function parseOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return url.origin;
}

// Throws on invalid values so a misconfigured server fails at startup, not on
// the first login.
export function loadDashboardConfig(env: Record<string, string | undefined>, defaultDashboardDir: string): DashboardConfig {
  const publicUrl = parseOrigin(env.PUBLIC_URL ?? "http://localhost:3000", "PUBLIC_URL");

  const signup = env.SIGNUP ?? "invite-only";
  if (!(SIGNUP_MODES as readonly string[]).includes(signup)) {
    throw new Error('SIGNUP must be "open" or "invite-only"');
  }

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together");
  }
  const github =
    clientId && clientSecret
      ? { clientId, clientSecret, baseUrl: parseOrigin(env.GITHUB_BASE_URL ?? "https://github.com", "GITHUB_BASE_URL") }
      : undefined;

  return {
    publicUrl,
    signup: signup as SignupMode,
    github,
    trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
    dashboardDir: env.DASHBOARD_DIR ?? defaultDashboardDir,
  };
}
