import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { queryKeys } from "./queries";

export function createQueryClient(): QueryClient {
  // A 401 from any request means the session is gone (expired, logged out
  // elsewhere, password changed); a 403 "Email not verified" means the server
  // started requiring verification. Either way, refetching "me" lets
  // RequireAuth show the right page. Skipped for "me" itself, which would loop.
  const onAuthError = (error: Error, queryKey?: readonly unknown[]) => {
    const authError =
      error instanceof ApiError && (error.status === 401 || (error.status === 403 && error.message === "Email not verified"));
    if (authError && queryKey?.[0] !== queryKeys.me[0]) {
      void client.invalidateQueries({ queryKey: queryKeys.me });
    }
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onAuthError(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => onAuthError(error) }),
    defaultOptions: {
      // API errors are answers, not blips — don't retry them.
      queries: { retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2 },
    },
  });
  return client;
}
