import { Link, NavLink, Outlet, useParams } from "react-router";
import { Card, PageHeader } from "../components/ui";
import { useProjects } from "../queries";

export function ProjectNotFound({ orgId }: { orgId: string }) {
  return (
    <Card className="space-y-2">
      <h1 className="text-lg font-semibold">Project not found</h1>
      <Link to={`/orgs/${orgId}/projects`} className="text-sm text-accent hover:underline">
        All projects
      </Link>
    </Card>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `-mb-px border-b-2 pb-2 text-sm ${isActive ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`;

export function ProjectLayout() {
  const { orgId = "", projectId = "" } = useParams();
  const projects = useProjects(orgId);
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.data && !project) {
    return <ProjectNotFound orgId={orgId} />;
  }

  const base = `/orgs/${orgId}/projects/${projectId}`;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-muted hover:text-fg">
          ← All projects
        </Link>
        <PageHeader title={project?.name ?? "Project"} />
      </div>
      <nav className="flex gap-6 border-b border-border">
        <NavLink to={base} end className={tabClass}>
          Timelines
        </NavLink>
        <NavLink to={`${base}/keys`} className={tabClass}>
          Keys
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
