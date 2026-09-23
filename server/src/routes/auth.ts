import type { FastifyInstance } from "fastify";
import { signUp } from "../accounts";
import { hashPassword, verifyPasswordOrDummy } from "../auth/password";
import { SESSION_COOKIE, clearSessionCookie, startSession } from "../auth/http";
import { deleteSession } from "../db/sessions";
import { countUsers, findUserByEmail, normalizeEmail } from "../db/users";
import { rateLimitErrorBody } from "../rate-limit";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";
import { meBody } from "./me";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const passwordSchema = { type: "string", minLength: 8, maxLength: 256 } as const;

const signupSchema = {
  type: "object",
  required: ["email", "name", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    name: { type: "string", maxLength: 100 },
    password: passwordSchema,
    inviteToken: { type: "string", maxLength: 100 },
  },
  additionalProperties: false,
} as const;

const loginSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", maxLength: 256 },
  },
  additionalProperties: false,
} as const;

const SIGNUP_ERRORS = {
  signup_closed: [403, "Signup is invite-only"],
  invite_invalid: [404, "Invite not found or expired"],
  email_taken: [409, "Email already registered"],
  github_taken: [409, "GitHub account already linked"],
} as const;

interface SignupBody {
  email: string;
  name: string;
  password: string;
  inviteToken?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const authRateLimit = {
    max: ctx.authRateLimitMax,
    timeWindow: "1 minute",
    errorResponseBuilder: rateLimitErrorBody,
  };

  // Drives the login/signup UI: whether to offer signup and a GitHub button.
  app.get("/api/auth/config", async () => ({
    signup: ctx.signup,
    bootstrapped: (await countUsers(db)) > 0,
    github: ctx.github !== undefined,
  }));

  app.post<{ Body: SignupBody }>(
    "/api/auth/signup",
    { schema: { body: signupSchema }, config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_PATTERN.test(email)) {
        throw httpError(400, "Invalid email");
      }
      const name = requireName(request.body.name, "Name is required");

      const result = await signUp(db, {
        email,
        name,
        passwordHash: await hashPassword(request.body.password),
        githubId: null,
        inviteToken: request.body.inviteToken,
        mode: ctx.signup,
      });
      if (!result.ok) {
        const [status, message] = SIGNUP_ERRORS[result.reason];
        return reply.code(status).send({ error: message });
      }

      await startSession(db, reply, result.user.id, ctx.secureCookies);
      return reply.code(201).send(await meBody(db, result.user));
    }
  );

  app.post<{ Body: LoginBody }>(
    "/api/auth/login",
    { schema: { body: loginSchema }, config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const user = await findUserByEmail(db, request.body.email);
      // Always one scrypt verification, so timing doesn't reveal whether the
      // email exists or the account is GitHub-only.
      const valid = await verifyPasswordOrDummy(request.body.password, user?.passwordHash ?? null);
      if (!user || !valid) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      await startSession(db, reply, user.id, ctx.secureCookies);
      return meBody(db, user);
    }
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
