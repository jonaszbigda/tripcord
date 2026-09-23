// Messages for the `error` codes the server's GitHub callback redirects with.
export const LOGIN_ERRORS: Record<string, string> = {
  github_state: "GitHub sign-in expired. Please try again.",
  github_failed: "GitHub sign-in failed. Please try again.",
  github_no_email: "Your GitHub account has no verified email address.",
  github_email_exists:
    "An account with this email already exists. Log in with your password and connect GitHub from settings.",
  signup_closed: "Signup is invite-only on this instance. Ask an organization owner for an invite link.",
  invite_invalid: "This invite link is invalid or has expired.",
  not_logged_in: "Log in first, then connect GitHub from settings.",
};

export const SETTINGS_ERRORS: Record<string, string> = {
  github_taken: "That GitHub account is already linked to another user.",
  github_failed: "Connecting GitHub failed. Please try again.",
};

/** A post-login redirect target, only if it's a path on this site (no open redirects). */
export function safeNext(value: string | null): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function inviteTokenFromNext(next: string | null): string | undefined {
  return next?.match(/^\/invite\/([A-Za-z0-9_-]+)/)?.[1];
}

export function githubHref(intent: "login" | "connect", invite?: string): string {
  const params = new URLSearchParams({ intent });
  if (invite) {
    params.set("invite", invite);
  }
  return `/api/auth/github?${params}`;
}
