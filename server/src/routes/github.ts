import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signUp, type SignUpResult } from "../accounts";
import { SESSION_COOKIE, startSession } from "../auth/http";
import { fetchGithubProfile, githubAuthorizeUrl, type GithubProfile } from "../auth/github";
import { generateToken } from "../auth/tokens";
import { findSessionUser } from "../db/sessions";
import { findUserByEmail, findUserByGithubId, setGithubId } from "../db/users";
import type { ApiContext } from "./context";

const OAUTH_COOKIE = "repro_oauth";
// Scoped so the cookie only travels to the start and callback routes.
const OAUTH_COOKIE_PATH = "/api/auth/github";

type Intent = "login" | "connect";

const SIGNUP_REDIRECTS: Record<Extract<SignUpResult, { ok: false }>["reason"], string> = {
  signup_closed: "/login?error=signup_closed",
  invite_invalid: "/login?error=invite_invalid",
  email_taken: "/login?error=github_email_exists",
  github_taken: "/login?error=github_failed",
};

// Every outcome is a redirect into the SPA, which maps `error` codes to messages.
export function registerGithubRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const redirectUri = `${ctx.publicUrl}/api/auth/github/callback`;

  app.get<{ Querystring: { intent?: string; invite?: string } }>("/api/auth/github", async (request, reply) => {
    if (!ctx.github) {
      return reply.code(404).send({ error: "Not Found" });
    }
    const intent: Intent = request.query.intent === "connect" ? "connect" : "login";
    const invite = request.query.invite ?? "";
    // The cookie value is `state.intent.invite`; tokens are base64url, so no dots.
    if (!/^[A-Za-z0-9_-]*$/.test(invite)) {
      return reply.redirect("/login?error=invite_invalid");
    }
    const { token: state } = generateToken();
    reply.setCookie(OAUTH_COOKIE, [state, intent, invite].join("."), {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.secureCookies,
      path: OAUTH_COOKIE_PATH,
      maxAge: 600,
    });
    return reply.redirect(githubAuthorizeUrl(ctx.github, state, redirectUri));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/api/auth/github/callback",
    async (request, reply) => {
      if (!ctx.github) {
        return reply.code(404).send({ error: "Not Found" });
      }
      const [state, intent, invite] = (request.cookies[OAUTH_COOKIE] ?? "").split(".");
      reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
      if (!state || state !== request.query.state || !request.query.code) {
        return reply.redirect("/login?error=github_state");
      }

      let profile: GithubProfile;
      try {
        profile = await fetchGithubProfile(ctx.github, request.query.code, redirectUri, ctx.githubFetch);
      } catch (error) {
        request.log.warn({ err: error }, "GitHub sign-in failed");
        return reply.redirect(intent === "connect" ? "/settings?error=github_failed" : "/login?error=github_failed");
      }

      return intent === "connect" ? connect(request, reply, profile) : login(reply, profile, invite || undefined);
    }
  );

  async function connect(request: FastifyRequest, reply: FastifyReply, profile: GithubProfile) {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!user) {
      return reply.redirect("/login?error=not_logged_in");
    }
    const linked = await findUserByGithubId(db, profile.id);
    if (linked && linked.id !== user.id) {
      return reply.redirect("/settings?error=github_taken");
    }
    await setGithubId(db, user.id, profile.id);
    return reply.redirect("/settings");
  }

  async function login(reply: FastifyReply, profile: GithubProfile, invite: string | undefined) {
    const linked = await findUserByGithubId(db, profile.id);
    if (linked) {
      await startSession(db, reply, linked.id, ctx.secureCookies);
      // An existing user who came from an invite link goes back to accept it.
      return reply.redirect(invite ? `/invite/${invite}` : "/");
    }
    if (!profile.email) {
      return reply.redirect("/login?error=github_no_email");
    }
    // Never auto-link by email: password accounts' emails are unverified, so the
    // account could belong to someone who registered this address in advance.
    if (await findUserByEmail(db, profile.email)) {
      return reply.redirect("/login?error=github_email_exists");
    }
    const result = await signUp(db, {
      email: profile.email,
      name: (profile.name?.trim() || profile.login).slice(0, 100),
      passwordHash: null,
      githubId: profile.id,
      inviteToken: invite,
      mode: ctx.signup,
    });
    if (!result.ok) {
      return reply.redirect(SIGNUP_REDIRECTS[result.reason]);
    }
    await startSession(db, reply, result.user.id, ctx.secureCookies);
    return reply.redirect("/");
  }
}
