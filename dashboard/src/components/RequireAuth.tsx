import { Navigate, Outlet, useLocation } from "react-router";
import { ApiError } from "../api";
import { useMe } from "../queries";
import { FullPageMessage } from "./ui";

// Gate for every logged-in page: children can assume useMe().data is loaded.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.error instanceof ApiError && me.error.status === 401) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // Checked before other errors: a failed background refetch keeps the page up.
  if (me.data) {
    return <Outlet />;
  }
  if (me.error) {
    return <FullPageMessage>{me.error.message}</FullPageMessage>;
  }
  return <FullPageMessage>Loading…</FullPageMessage>;
}
