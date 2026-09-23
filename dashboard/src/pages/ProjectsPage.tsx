import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useProjects } from "../queries";
import type { CreatedProject } from "../types";

export function ProjectsPage() {
  const { orgId = "" } = useParams();
  const projects = useProjects(orgId);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedProject | null>(null);

  const create = useMutation({
    mutationFn: () => api<CreatedProject>("POST", `/api/orgs/${orgId}/projects`, { name }),
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(orgId) });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" />
      {created && (
        <OnceSecret
          label={`API key for ${created.project.name}`}
          value={created.key}
          onDismiss={() => setCreated(null)}
        />
      )}
      <Card>
        <form
          className="flex items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField className="flex-1" label="New project name" value={name} onChange={setName} required maxLength={100} />
          <Button type="submit" disabled={create.isPending}>
            Create project
          </Button>
        </form>
        <ErrorText error={create.error} />
      </Card>
      {projects.error ? (
        <ErrorText error={projects.error} />
      ) : !projects.data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : projects.data.length === 0 ? (
        <p className="text-sm text-muted">No projects yet. Create one to get an API key.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Active keys</th>
              <th className="font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.data.map((project) => (
              <tr key={project.id} className="border-t border-border">
                <td className="py-2">
                  <Link className="font-medium text-accent hover:underline" to={`/orgs/${orgId}/projects/${project.id}`}>
                    {project.name}
                  </Link>
                </td>
                <td>{project.activeKeyCount}</td>
                <td>{formatDate(project.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
