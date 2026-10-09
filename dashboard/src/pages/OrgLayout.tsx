import { Link, Outlet, useParams } from "react-router";
import { Card } from "../components/ui";
import { useMe } from "../queries";

export function OrgLayout() {
  const { orgId = "" } = useParams();
  const org = useMe().data?.orgs.find((o) => o.id === orgId);

  if (!org) {
    return (
      <Card className="mx-auto max-w-md space-y-2">
        <h1 className="text-lg font-semibold">Organization not found</h1>
        <p className="text-sm text-muted">It doesn't exist, or you aren't a member.</p>
        <Link to="/" className="text-sm text-accent hover:underline">
          Go home
        </Link>
      </Card>
    );
  }

  return <Outlet />;
}
