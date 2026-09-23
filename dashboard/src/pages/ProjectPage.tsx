import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText, PageHeader } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useKeys, useProjects } from "../queries";
import type { CreatedApiKey } from "../types";

export function ProjectPage() {
  const { orgId = "", projectId = "" } = useParams();
  const project = useProjects(orgId).data?.find((p) => p.id === projectId);
  const keys = useKeys(orgId, projectId);
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.keys(orgId, projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(orgId) }),
    ]);

  const createKey = useMutation({
    mutationFn: () => api<CreatedApiKey>("POST", `/api/orgs/${orgId}/projects/${projectId}/keys`),
    onSuccess: (result) => {
      setNewKey(result.key);
      void refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api("POST", `/api/orgs/${orgId}/projects/${projectId}/keys/${keyId}/revoke`),
    onSuccess: () => void refresh(),
  });

  if (keys.error instanceof ApiError && keys.error.status === 404) {
    return (
      <Card className="space-y-2">
        <h1 className="text-lg font-semibold">Project not found</h1>
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-accent hover:underline">
          All projects
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-muted hover:text-fg">
          ← All projects
        </Link>
        <PageHeader title={project?.name ?? "Project"} />
      </div>

      <Card className="space-y-2">
        <h2 className="font-medium">Ingest endpoint</h2>
        <p className="text-sm text-muted">
          Point <code className="font-mono">@repro/js</code> at this URL and pass one of the keys below as{" "}
          <code className="font-mono">apiKey</code>.
        </p>
        <code className="block rounded-md bg-bg px-2 py-1.5 font-mono text-sm">{`${window.location.origin}/v1/timeline`}</code>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">API keys</h2>
          <Button onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            Create key
          </Button>
        </div>
        {newKey && <OnceSecret label="New API key" value={newKey} onDismiss={() => setNewKey(null)} />}
        <ErrorText error={createKey.error ?? revoke.error ?? keys.error} />
        {keys.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-2 font-medium">Key</th>
                <th className="font-medium">Created</th>
                <th className="font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((key) => (
                <tr key={key.id} className="border-t border-border">
                  <td className="py-2 font-mono">{`${key.prefix}…`}</td>
                  <td>{formatDate(key.createdAt)}</td>
                  <td>{key.revokedAt ? `Revoked ${formatDate(key.revokedAt)}` : "Active"}</td>
                  <td className="text-right">
                    {!key.revokedAt && (
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Confirm revoke"
                        disabled={revoke.isPending}
                        onConfirm={() => revoke.mutate(key.id)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="space-y-1">
        <h2 className="font-medium">Timelines</h2>
        <p className="text-sm text-muted">Captured timelines will appear here.</p>
      </Card>
    </div>
  );
}
