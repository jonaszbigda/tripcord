import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { queryKeys } from "../queries";
import type { Me } from "../types";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

function retryAfter(error: Error | null): number {
  return error instanceof ApiError && error.status === 429
    ? ((error.body as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0)
    : 0;
}

// Shown by RequireAuth in place of any page while the server requires
// verification. Offers only what an unverified account can do.
export function VerifyEmailPendingPage({ me }: { me: Me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [wait, setWait] = useState(0);
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const resend = useMutation({
    mutationFn: () => api<void>("POST", "/api/me/verify-email/resend"),
    onError: (error) => setWait(retryAfter(error)),
  });
  const change = useMutation({
    mutationFn: () => api<void>("PATCH", "/api/me/email", { email: newEmail }),
    onSuccess: async () => {
      setEditing(false);
      setNewEmail("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) => setWait(retryAfter(error)),
  });
  const leave = () => {
    navigate("/login", { replace: true });
    queryClient.clear();
  };
  const logout = useMutation({ mutationFn: () => api<void>("POST", "/api/auth/logout"), onSuccess: leave });
  const deleteAccount = useMutation({ mutationFn: () => api<void>("DELETE", "/api/me", { password }), onSuccess: leave });

  return (
    <AuthCard title="Check your inbox">
      <div className="space-y-4 text-sm">
        <p>
          We sent a link to <strong>{me.user.email}</strong>. Open it to finish signing up.
        </p>

        <div className="space-y-2">
          <Button variant="secondary" onClick={() => resend.mutate()} disabled={resend.isPending || wait > 0}>
            Resend email
          </Button>
          {resend.isSuccess && wait === 0 && <p className="text-muted">Sent. Check your inbox and spam folder.</p>}
          {wait > 0 && <p className="text-muted">You can resend in {wait} s.</p>}
          {resend.error && retryAfter(resend.error) === 0 && <ErrorText error={resend.error} />}
        </div>

        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              change.mutate();
            }}
          >
            <TextField label="New email" type="email" autoComplete="email" value={newEmail} onChange={setNewEmail} required maxLength={254} />
            {change.error && retryAfter(change.error) === 0 && <ErrorText error={change.error} />}
            <Button type="submit" disabled={change.isPending || wait > 0}>
              Change and resend
            </Button>
          </form>
        ) : (
          <button type="button" className="text-accent hover:underline" onClick={() => setEditing(true)}>
            Wrong address?
          </button>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </Button>
          <button type="button" className="text-danger hover:underline" onClick={() => setDeleting((open) => !open)}>
            Delete account
          </button>
        </div>

        {deleting && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              deleteAccount.mutate();
            }}
          >
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
            <ErrorText error={deleteAccount.error} />
            <Button type="submit" variant="danger" disabled={deleteAccount.isPending || password === ""}>
              Delete my account
            </Button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
