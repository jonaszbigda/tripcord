import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText, PageHeader } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useInvites, useMe, useMembers, useOrgRole } from "../queries";
import type { Invite, Me, Role } from "../types";

export function MembersPage() {
  const { orgId = "" } = useParams();
  const me = useMe().data!;
  const isOwner = useOrgRole(orgId) === "owner";
  const members = useMembers(orgId);
  const invites = useInvites(orgId, isOwner);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);

  const invalidate = (queryKey: readonly unknown[]) => queryClient.invalidateQueries({ queryKey });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api("PATCH", `/api/orgs/${orgId}/members/${userId}`, { role }),
    onSettled: () => {
      void invalidate(queryKeys.members(orgId));
      void invalidate(queryKeys.me);
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api("DELETE", `/api/orgs/${orgId}/members/${userId}`),
    onSuccess: async (_result, userId) => {
      if (userId === me.user.id) {
        // A "me" request already in flight still lists this org; if it landed
        // after setQueryData, HomePage would send the user back into the org.
        await queryClient.cancelQueries({ queryKey: queryKeys.me });
        queryClient.setQueryData<Me>(queryKeys.me, (old) => old && { ...old, orgs: old.orgs.filter((o) => o.id !== orgId) });
        navigate("/");
      } else {
        void invalidate(queryKeys.members(orgId));
      }
    },
  });

  const createInvite = useMutation({
    mutationFn: () => api<{ invite: Invite; link: string }>("POST", `/api/orgs/${orgId}/invites`, { role: inviteRole }),
    onSuccess: (result) => {
      setLink(result.link);
      void invalidate(queryKeys.invites(orgId));
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => api("DELETE", `/api/orgs/${orgId}/invites/${inviteId}`),
    onSuccess: () => void invalidate(queryKeys.invites(orgId)),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Members" />
      <ErrorText error={changeRole.error ?? remove.error ?? createInvite.error ?? revokeInvite.error ?? members.error} />
      {members.data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Email</th>
              <th className="font-medium">Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => {
              const isSelf = member.userId === me.user.id;
              return (
                <tr key={member.userId} className="border-t border-border">
                  <td className="py-2">{member.name}</td>
                  <td>{member.email}</td>
                  <td>
                    {isOwner ? (
                      <select
                        aria-label={`Role for ${member.name}`}
                        className="rounded-md border border-border bg-surface px-2 py-1"
                        value={member.role}
                        onChange={(event) =>
                          changeRole.mutate({ userId: member.userId, role: event.target.value as Role })
                        }
                      >
                        <option value="owner">owner</option>
                        <option value="member">member</option>
                      </select>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td className="text-right">
                    {isSelf ? (
                      <ConfirmButton label="Leave" confirmLabel="Confirm leave" onConfirm={() => remove.mutate(member.userId)} />
                    ) : (
                      isOwner && (
                        <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove.mutate(member.userId)} />
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {isOwner && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Invites</h2>
            <div className="flex items-center gap-2">
              <select
                aria-label="Invite role"
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
              >
                <option value="member">member</option>
                <option value="owner">owner</option>
              </select>
              <Button onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                Create invite link
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted">Links work once and expire after 7 days. Send one to the person you're inviting.</p>
          {link && <OnceSecret label="Invite link" value={link} onDismiss={() => setLink(null)} />}
          {invites.data && invites.data.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {invites.data.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between py-2">
                  <span>
                    {invite.role} · Created by {invite.createdByName ?? "a deleted user"} · Expires {formatDate(invite.expiresAt)}
                  </span>
                  <ConfirmButton label="Revoke" confirmLabel="Confirm revoke" onConfirm={() => revokeInvite.mutate(invite.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
