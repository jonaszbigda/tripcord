import type { SignupMode } from "../accounts";
import type { GithubConfig } from "../config";
import type { Database } from "../db/client";

/** What every /api route module needs from the app's configuration. */
export interface ApiContext {
  db: Database;
  /** Origin of the dashboard, e.g. https://app.reprojs.dev — no trailing slash. */
  publicUrl: string;
  secureCookies: boolean;
  signup: SignupMode;
  github?: GithubConfig;
  githubFetch: typeof fetch;
  /** Per-IP login/signup attempts per minute. */
  authRateLimitMax: number;
}
