import { useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorText, TypeToConfirm } from "../components/ui";
import { queryKeys, useOrgRole, useProjects } from "../queries";
import type { Project } from "../types";

export function ProjectSettingsPage() {
  const { orgId = "", projectId = "" } = useParams();
  const project = useProjects(orgId).data?.find((p) => p.id === projectId); // ProjectLayout handles "not found"
  const role = useOrgRole(orgId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/orgs/${orgId}/projects/${projectId}`),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects(orgId) });
      queryClient.setQueryData<Project[]>(queryKeys.projects(orgId), (old) => old?.filter((p) => p.id !== projectId));
      navigate(`/orgs/${orgId}/projects`, { replace: true });
    },
  });

  if (!project) {
    return null;
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <h2 className="font-medium">Export</h2>
        <p className="text-sm text-muted">
          Download every timeline of this project as NDJSON: one JSON object per line, oldest first.
        </p>
        <a
          href={`/api/orgs/${orgId}/projects/${projectId}/export`}
          download
          className="inline-flex rounded-lg border border-border bg-raised px-3.5 py-2 text-sm font-medium hover:border-muted/50"
        >
          Export timelines
        </a>
      </Card>
      <Card className="space-y-3">
        <h2 className="font-medium text-danger">Delete project</h2>
        {role === "owner" ? (
          <>
            <p className="text-sm text-muted">
              Deletes the project, its API keys and all its timelines. Apps still sending with its keys get 401. This
              can't be undone.
            </p>
            <TypeToConfirm
              label={`Type "${project.name}" to confirm`}
              expected={project.name}
              buttonLabel="Delete project"
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
            <ErrorText error={remove.error} />
          </>
        ) : (
          <p className="text-sm text-muted">Only owners can delete a project.</p>
        )}
      </Card>
    </div>
  );
}
