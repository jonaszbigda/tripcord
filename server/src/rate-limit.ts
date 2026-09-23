import type { FastifyRequest } from "fastify";
import type { errorResponseBuilderContext } from "@fastify/rate-limit";

// @fastify/rate-limit throws what this returns, and Fastify reads `.statusCode`
// off it to set the reply status. `statusCode` is defined non-enumerable so it
// drives the status without leaking into the JSON body; app.ts's error handler
// forwards the `{ error }` shape as-is.
export function rateLimitErrorBody(_request: FastifyRequest, context: errorResponseBuilderContext) {
  const body = { error: `Rate limit exceeded, retry in ${context.after}` };
  Object.defineProperty(body, "statusCode", { value: context.statusCode, enumerable: false });
  return body;
}
