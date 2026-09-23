import { Link, NavLink, Outlet, useParams } from "react-router";
import { Card } from "../components/ui";
import { useMe } from "../queries";

// `ownerOnly` tabs are hidden from members (the server enforces it regardless).
const TABS: { path: string; label: string; ownerOnly?: boolean }[] = [
  { path: "projects", label: "Projects" },
  { path: "members", label: "Members" },
  { path: "settings", label: "Settings", ownerOnly: true },
];

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

  const visible = TABS.filter((tab) => !tab.ownerOnly || org.role === "owner");
  return (
    <div className="space-y-6">
      <nav className="flex gap-6 border-b border-border">
        {visible.map((tab) => (
          <NavLink
            key={tab.path}
            to={`/orgs/${orgId}/${tab.path}`}
            className={({ isActive }) =>
              `-mb-px border-b-2 pb-2 text-sm ${isActive ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
