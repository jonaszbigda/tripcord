import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { queryKeys } from "./queries";

export function createQueryClient(): QueryClient {
  // A 401 from any request means the session is gone (expired, logged out
  // elsewhere, password changed). Refetching "me" makes RequireAuth send the
  // user to /login. Skipped for "me" itself, which would loop.
  const onUnauthorized = (error: Error, queryKey?: readonly unknown[]) => {
    if (error instanceof ApiError && error.status === 401 && queryKey?.[0] !== queryKeys.me[0]) {
      void client.invalidateQueries({ queryKey: queryKeys.me });
    }
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onUnauthorized(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => onUnauthorized(error) }),
    defaultOptions: {
      // API errors are answers, not blips — don't retry them.
      queries: { retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2 },
    },
  });
  return client;
}
