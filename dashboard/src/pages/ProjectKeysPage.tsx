import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useKeys } from "../queries";
import type { CreatedApiKey } from "../types";

export function ProjectKeysPage() {
  const { orgId = "", projectId = "" } = useParams();
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

  return (
    <div className="space-y-6">
      <Card className="space-y-2">
        <h2 className="font-medium">Ingest endpoint</h2>
        <p className="text-sm text-muted">
          Point <code className="font-mono">@tripcord/js</code> at this URL and pass one of the keys below as{" "}
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
    </div>
  );
}
