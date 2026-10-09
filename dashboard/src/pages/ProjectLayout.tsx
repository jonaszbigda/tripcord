import { Link, Outlet, useParams } from "react-router";
import { ChevronRightIcon, FolderIcon } from "../components/icons";
import { Card, PageHeader } from "../components/ui";
import { useMe, useProjects } from "../queries";

export function ProjectNotFound({ orgId }: { orgId: string }) {
  return (
    <Card className="mx-auto max-w-md space-y-2">
      <h1 className="text-lg font-semibold">Project not found</h1>
      <Link to={`/orgs/${orgId}/projects`} className="text-sm text-accent hover:underline">
        All projects
      </Link>
    </Card>
  );
}

export function ProjectLayout() {
  const { orgId = "", projectId = "" } = useParams();
  const org = useMe().data?.orgs.find((o) => o.id === orgId);
  const projects = useProjects(orgId);
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.data && !project) {
    return <ProjectNotFound orgId={orgId} />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
          {org && (
            <>
              <span>{org.name}</span>
              <ChevronRightIcon className="size-3.5" />
            </>
          )}
          <Link to={`/orgs/${orgId}/projects`} className="transition hover:text-fg">
            Projects
          </Link>
        </nav>
        <PageHeader title={project?.name ?? "Project"} icon={<FolderIcon className="size-6" />} />
      </div>
      <Outlet />
    </div>
  );
}
