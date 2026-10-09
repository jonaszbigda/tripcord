import type { ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useProjects } from "../queries";
import type { Me, UserOrg } from "../types";
import { ActivityIcon, ArrowLeftIcon, FolderIcon, KeyIcon, LogOutIcon, SettingsIcon, UsersIcon } from "./icons";
import { Button, Wordmark } from "./ui";

const NEW_ORG = "__new__";

function OrgSwitcher({ orgs, currentOrgId }: { orgs: UserOrg[]; currentOrgId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <select
      aria-label="Organization"
      className="w-full rounded-lg border border-border bg-raised px-2.5 py-1.5 text-sm text-fg transition hover:border-muted/50"
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

const itemClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
    isActive
      ? "bg-raised font-medium text-fg shadow-[inset_2px_0_0_var(--color-accent)]"
      : "text-muted hover:bg-raised/60 hover:text-fg"
  }`;

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-3 pt-5 pb-1 text-[11px] font-semibold tracking-wider text-muted/80 uppercase">{children}</p>;
}

/**
 * The left navigation. Cloudflare-style: it holds the org switcher and one set
 * of links at a time — the org's sections at the org level, the project's
 * sections once a project is open. The project name sits above its links, so a
 * "Settings" is never ambiguous.
 */
export function Sidebar({
  me,
  currentOrgId,
  open,
  onClose,
  onLogout,
  loggingOut,
}: {
  me: Me;
  currentOrgId: string | undefined;
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const { pathname } = useLocation();
  const projectId = /^\/orgs\/[^/]+\/projects\/([^/]+)/.exec(pathname)?.[1];
  const org = me.orgs.find((o) => o.id === currentOrgId);
  const projects = useProjects(currentOrgId ?? "", Boolean(currentOrgId && projectId));
  const project = projects.data?.find((p) => p.id === projectId);

  return (
    <aside
      aria-label="Primary"
      className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border/60 bg-surface transition-transform lg:z-30 lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex items-center gap-2 px-4 pt-6 pb-3">
        <Link to="/" aria-label="Tripcord" className="text-lg">
          <Wordmark />
        </Link>
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:text-fg lg:hidden"
        >
          ×
        </button>
      </div>

      {me.orgs.length > 0 && (
        <div className="px-3 pb-2">
          <OrgSwitcher orgs={me.orgs} currentOrgId={currentOrgId} />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {projectId && currentOrgId ? (
          <>
            <Link
              to={`/orgs/${currentOrgId}/projects`}
              aria-label="All projects"
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-raised/60 hover:text-fg"
            >
              <ArrowLeftIcon />
              Projects
            </Link>
            <SectionLabel>{project?.name ?? "Project"}</SectionLabel>
            <NavLink to={`/orgs/${currentOrgId}/projects/${projectId}`} end className={itemClass}>
              <ActivityIcon />
              Timelines
            </NavLink>
            <NavLink to={`/orgs/${currentOrgId}/projects/${projectId}/keys`} className={itemClass}>
              <KeyIcon />
              Keys
            </NavLink>
            <NavLink to={`/orgs/${currentOrgId}/projects/${projectId}/settings`} className={itemClass}>
              <SettingsIcon />
              Settings
            </NavLink>
          </>
        ) : org ? (
          <>
            <SectionLabel>Organization</SectionLabel>
            <NavLink to={`/orgs/${org.id}/projects`} end className={itemClass}>
              <FolderIcon />
              Projects
            </NavLink>
            <NavLink to={`/orgs/${org.id}/members`} className={itemClass}>
              <UsersIcon />
              Members
            </NavLink>
            {org.role === "owner" && (
              <NavLink to={`/orgs/${org.id}/settings`} className={itemClass}>
                <SettingsIcon />
                Settings
              </NavLink>
            )}
          </>
        ) : null}
      </nav>

      <div className="mt-auto space-y-2 border-t border-border/60 p-3">
        <Link
          to="/settings"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted transition hover:bg-raised/60 hover:text-fg"
        >
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-cord text-xs font-semibold text-accent-fg"
          >
            {me.user.name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="truncate">{me.user.name}</span>
        </Link>
        <Button variant="secondary" className="w-full" onClick={onLogout} disabled={loggingOut} icon={<LogOutIcon />}>
          Log out
        </Button>
      </div>
    </aside>
  );
}
