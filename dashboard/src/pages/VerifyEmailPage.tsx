import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queries";
import { AuthCard, FullPageMessage } from "../components/ui";

// Public: the link may be opened on a device with no session. Posts the token
// once per page load; the ref stops StrictMode's second effect run from using
// up the token and then showing "expired".
export function VerifyEmailPage() {
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const sent = useRef(false);
  const verify = useMutation({
    mutationFn: () => api<void>("POST", "/api/auth/verify-email", { token }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    verify.mutate();
  }, [verify]);

  if (verify.isSuccess) {
    return (
      <AuthCard title="Email verified">
        <Link className="text-sm text-accent hover:underline" to="/">
          Continue to Tripcord
        </Link>
      </AuthCard>
    );
  }
  if (verify.isError) {
    return (
      <AuthCard title="Link expired">
        <p className="text-sm">This link is invalid or has expired. Log in to send a new one.</p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Log in
        </Link>
      </AuthCard>
    );
  }
  return <FullPageMessage>Verifying…</FullPageMessage>;
}
