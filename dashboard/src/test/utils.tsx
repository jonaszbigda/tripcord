import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";
import { AppRoutes } from "../App";
import { createQueryClient } from "../queryClient";

export interface MockResponse {
  status?: number;
  body?: unknown;
}

/** A canned response, or a function of the parsed request body. */
export type MockHandler = MockResponse | ((body: unknown) => MockResponse);

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Replaces fetch with handlers keyed by "METHOD /path" (falling back to the path
 * without its query string). Unhandled requests get a 404. Handlers are looked up per request, so a test can reassign one mid-test.
 * Returns the list of calls made.
 */
export function mockApi(handlers: Record<string, MockHandler>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      // Exact "METHOD /path?query" first, then the path alone, so a test can
      // answer every query of one endpoint with a single handler.
      const handler = handlers[`${method} ${path}`] ?? handlers[`${method} ${path.split("?")[0]}`];
      const result: MockResponse =
        handler === undefined
          ? { status: 404, body: { error: "Not Found" } }
          : typeof handler === "function"
            ? handler(body)
            : handler;
      const status = result.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

/** Renders the whole app at `path`, plus a data-testid="location" probe. */
export function renderApp(path: string) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client };
}
