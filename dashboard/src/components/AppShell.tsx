import { Link, Outlet, useMatch, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../queries";
import type { UserOrg } from "../types";
import { Button, Wordmark } from "./ui";

const NEW_ORG = "__new__";

function OrgSwitcher({ orgs, currentOrgId }: { orgs: UserOrg[]; currentOrgId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <select
      aria-label="Organization"
      className="min-w-0 max-w-36 rounded-lg border border-border bg-raised px-2.5 py-1.5 text-sm text-fg transition hover:border-muted/50 sm:max-w-none"
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
      <header className="sticky top-0 z-20 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:gap-4">
          <Link to="/" aria-label="Tripcord" className="shrink-0 text-lg">
            <Wordmark />
          </Link>
          <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />
          <OrgSwitcher orgs={me.orgs} currentOrgId={currentOrgId} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link to="/settings" className="flex items-center gap-2 text-muted transition hover:text-fg">
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-cord text-xs font-semibold text-accent-fg"
              >
                {me.user.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="hidden sm:inline">{me.user.name}</span>
            </Link>
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </div>
        </div>
        {/* The cord: the one gradient line that runs under every page. */}
        <div aria-hidden="true" className="h-px bg-[linear-gradient(90deg,transparent,var(--color-accent)_20%,var(--color-amber)_60%,transparent)] opacity-70" />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Outlet />
      </main>
    </div>
  );
}
