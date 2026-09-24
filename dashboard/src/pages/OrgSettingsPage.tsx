import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, ErrorText, PageHeader, TextField, TypeToConfirm } from "../components/ui";
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

  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/orgs/${orgId}`),
    onSuccess: async () => {
      // As when leaving an org: an in-flight /api/me must not bring the org back.
      await queryClient.cancelQueries({ queryKey: queryKeys.me });
      queryClient.setQueryData<Me>(queryKeys.me, (me) => me && { ...me, orgs: me.orgs.filter((o) => o.id !== orgId) });
      navigate("/", { replace: true });
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
      <Card className="space-y-3">
        <h2 className="font-medium text-danger">Delete organization</h2>
        <p className="text-sm text-muted">
          Deletes the organization with all its projects, API keys and timelines, and removes every member. Members
          keep their accounts. This can't be undone.
        </p>
        <TypeToConfirm
          label={`Type "${org.name}" to confirm`}
          expected={org.name}
          buttonLabel="Delete organization"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
        <ErrorText error={remove.error} />
      </Card>
    </div>
  );
}
