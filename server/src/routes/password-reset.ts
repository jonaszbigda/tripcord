import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth/password";
import { normalizeEmail } from "../db/users";
import { requestPasswordReset, resetPassword } from "../password-reset";
import { authRateLimit, passwordSchema } from "./auth";
import type { ApiContext } from "./context";

interface ResetRequestBody {
  email: string;
}

interface ResetConfirmBody {
  token: string;
  newPassword: string;
}

export function registerPasswordResetRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, mailer } = ctx;
  // Without SMTP the routes don't exist, and /api/auth/config says so.
  if (!mailer) {
    return;
  }
  const rateLimit = authRateLimit(ctx);

  app.post<{ Body: ResetRequestBody }>(
    "/api/auth/password-reset",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", maxLength: 254 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      // Started here, finished after the reply: neither the status nor the
      // response time says whether the address has an account.
      void requestPasswordReset(db, mailer, ctx.publicUrl, normalizeEmail(request.body.email)).catch((error: unknown) => {
        request.log.error({ err: error }, "password reset email failed");
      });
      return reply.code(204).send();
    }
  );

  app.post<{ Body: ResetConfirmBody }>(
    "/api/auth/password-reset/confirm",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "newPassword"],
          properties: { token: { type: "string", maxLength: 100 }, newPassword: passwordSchema },
          additionalProperties: false,
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      const ok = await resetPassword(db, request.body.token, await hashPassword(request.body.newPassword));
      if (!ok) {
        return reply.code(400).send({ error: "This reset link is invalid or has expired" });
      }
      return reply.code(204).send();
    }
  );
}
