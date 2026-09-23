import { Link, Outlet, useMatch, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../queries";
import type { UserOrg } from "../types";
import { Button } from "./ui";

const NEW_ORG = "__new__";

function OrgSwitcher({ orgs, currentOrgId }: { orgs: UserOrg[]; currentOrgId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <select
      aria-label="Organization"
      className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
      value={currentOrgId ?? ""}
      onChange={(event) =>
        navigate(event.target.value === NEW_ORG ? "/orgs/new" : `/orgs/${event.target.value}/projects`)
      }
    >
      {currentOrgId === undefined && (
        <option value="" disabled>
          Select organization
        </option>
      )}
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
      <option value={NEW_ORG}>+ New organization…</option>
    </select>
  );
}

export function AppShell() {
  const me = useMe().data!; // RequireAuth renders this only once "me" has loaded
  const matchedOrgId = useMatch("/orgs/:orgId/*")?.params.orgId;
  const currentOrgId = me.orgs.some((org) => org.id === matchedOrgId) ? matchedOrgId : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api<void>("POST", "/api/auth/logout"),
    onSuccess: () => {
      navigate("/login", { replace: true });
      queryClient.clear();
    },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            repro
          </Link>
          <OrgSwitcher orgs={me.orgs} currentOrgId={currentOrgId} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link to="/settings" className="text-muted hover:text-fg">
              {me.user.name}
            </Link>
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
