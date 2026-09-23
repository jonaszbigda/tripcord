import { Navigate } from "react-router";
import { useMe } from "../queries";

// "/" goes to the first org the user belongs to, or to creating one.
export function HomePage() {
  const first = useMe().data?.orgs[0];
  return <Navigate to={first ? `/orgs/${first.id}/projects` : "/orgs/new"} replace />;
}
