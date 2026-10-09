import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BuildingIcon, PlusIcon } from "../components/icons";
import { Button, Card, ErrorText, TextField } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { Me, UserOrg } from "../types";

export function NewOrgPage() {
  const hasOrgs = (useMe().data?.orgs.length ?? 0) > 0;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api<UserOrg>("POST", "/api/orgs", { name }),
    onSuccess: (org) => {
      queryClient.setQueryData<Me>(queryKeys.me, (me) => me && { ...me, orgs: [...me.orgs, org] });
      navigate(`/orgs/${org.id}/projects`);
    },
  });

  return (
    <Card className="mx-auto mt-16 max-w-md space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <BuildingIcon className="size-5 text-muted" />
        {hasOrgs ? "New organization" : "Create your organization"}
      </h1>
      {!hasOrgs && <p className="text-sm text-muted">You aren't a member of any organization yet.</p>}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <TextField label="Organization name" value={name} onChange={setName} required maxLength={100} icon={<BuildingIcon />} />
        <ErrorText error={create.error} />
        <Button type="submit" disabled={create.isPending} icon={<PlusIcon />}>
          Create organization
        </Button>
      </form>
    </Card>
  );
}
