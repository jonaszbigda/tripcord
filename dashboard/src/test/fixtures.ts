import type { AuthConfig, Me } from "../types";

export const ORG_ID = "org-1";

export const ME: Me = {
  user: { id: "user-1", email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false, emailVerified: true },
  orgs: [{ id: ORG_ID, name: "Acme", role: "owner" }],
};

export const CONFIG_OPEN: AuthConfig = {
  signup: "open",
  bootstrapped: true,
  github: true,
  passwordReset: true,
  emailVerification: false,
};
export const CONFIG_CLOSED: AuthConfig = {
  signup: "invite-only",
  bootstrapped: true,
  github: false,
  passwordReset: false,
  emailVerification: false,
};

export const UNVERIFIED_ME: Me = { ...ME, user: { ...ME.user, emailVerified: false } };
