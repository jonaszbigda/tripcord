export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed response body, for errors that carry more than a message. */
    readonly body: unknown = undefined
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

// Same-origin JSON calls to the server's /api routes. Content-Type is sent only
// with a body: the server rejects an empty body declared as JSON, and its CSRF
// guard accepts body-less requests without one.
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) {
    return undefined as T;
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`, data);
  }
  return data as T;
}
