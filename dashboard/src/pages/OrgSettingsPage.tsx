import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { Me } from "../types";

export function OrgSettingsPage() {
  const { orgId = "" } = useParams();
  const org = useMe().data!.orgs.find((o) => o.id === orgId)!; // OrgLayout checked membership
  const queryClient = useQueryClient();
  const [name, setName] = useState(org.name);

  const rename = useMutation({
    mutationFn: () => api<{ id: string; name: string }>("PATCH", `/api/orgs/${orgId}`, { name }),
    onSuccess: (renamed) => {
      queryClient.setQueryData<Me>(
        queryKeys.me,
        (me) => me && { ...me, orgs: me.orgs.map((o) => (o.id === renamed.id ? { ...o, name: renamed.name } : o)) }
      );
    },
  });

  if (org.role !== "owner") {
    return <p className="text-sm text-muted">Only owners can change organization settings.</p>;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Card>
        <form
          className="flex items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField className="flex-1" label="Organization name" value={name} onChange={setName} required maxLength={100} />
          <Button type="submit" disabled={rename.isPending}>
            Save
          </Button>
        </form>
        <ErrorText error={rename.error} />
      </Card>
    </div>
  );
}
