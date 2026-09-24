import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, FullPageMessage } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { InvitePreview, Me } from "../types";

// Public: shows the invite to anyone holding the link, then accept (logged in)
// or log in / sign up first (logged out), carrying the token along.
export function InvitePage() {
  const { token = "" } = useParams();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InvitePreview>("GET", `/api/invites/${token}`),
  });
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const accept = useMutation({
    mutationFn: () => api<{ orgId: string }>("POST", `/api/invites/${token}/accept`),
    onSuccess: ({ orgId }) => {
      const joined = { id: orgId, name: invite.data?.orgName ?? "", role: invite.data!.role };
      queryClient.setQueryData<Me>(queryKeys.me, (old) => old && { ...old, orgs: [...old.orgs, joined] });
      navigate(`/orgs/${orgId}/projects`);
    },
  });

  const logout = useMutation({
    mutationFn: () => api("POST", "/api/auth/logout"),
    // Refetches /api/me, which now fails, so the page shows the logged-out choices.
    onSuccess: () => queryClient.resetQueries({ queryKey: queryKeys.me }),
  });

  if (invite.error) {
    return (
      <AuthCard title="Invite unavailable">
        <p className="text-sm text-muted">{invite.error.message}</p>
        <Link className="text-sm text-accent hover:underline" to="/">
          Go home
        </Link>
      </AuthCard>
    );
  }
  if (!invite.data || me.isPending) {
    return <FullPageMessage>Loading…</FullPageMessage>;
  }

  if (invite.data.orgName === null) {
    return (
      <AuthCard title="You're invited to Tripcord">
        <p className="text-sm text-muted">This invite creates a new Tripcord account with its own organization.</p>
        {me.data ? (
          <>
            <p className="text-sm text-muted">
              You're signed in as {me.data.user.email}. This invite is for creating a new account. Log out to use it.
            </p>
            <ErrorText error={logout.error} />
            <Button className="w-full" variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </>
        ) : (
          <Link className="text-sm text-accent hover:underline" to={`/signup?invite=${token}`}>
            Create your account
          </Link>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${invite.data.orgName}`}>
      <p className="text-sm text-muted">
        You've been invited to join <strong className="text-fg">{invite.data.orgName}</strong> as {invite.data.role === "owner" ? "an owner" : "a member"}.
      </p>
      {me.data ? (
        <>
          <p className="text-sm text-muted">Signed in as {me.data.user.email}.</p>
          <ErrorText error={accept.error} />
          <Button className="w-full" onClick={() => accept.mutate()} disabled={accept.isPending}>
            Accept invite
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <Link className="text-accent hover:underline" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
            Log in to accept
          </Link>
          <Link className="text-accent hover:underline" to={`/signup?invite=${token}`}>
            Create an account
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
