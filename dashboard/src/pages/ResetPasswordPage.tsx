import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

// Doesn't log the user in: the server ends every session, and a leaked link
// alone should never become one.
export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const reset = useMutation({
    mutationFn: () => api("POST", "/api/auth/password-reset/confirm", { token, newPassword: password }),
    onSuccess: () => navigate("/login?reset=1", { replace: true }),
  });
  const mismatch = repeat !== "" && repeat !== password;

  return (
    <AuthCard title="Choose a new password">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          reset.mutate();
        }}
      >
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          maxLength={256}
        />
        <TextField
          label="Repeat new password"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={setRepeat}
          required
        />
        {mismatch && <p className="text-sm text-danger">The passwords don't match.</p>}
        <ErrorText error={reset.error} />
        <Button type="submit" className="w-full" disabled={reset.isPending || mismatch}>
          Set password
        </Button>
      </form>
      {reset.error && (
        <Link className="text-sm text-accent hover:underline" to="/reset-password">
          Request a new link
        </Link>
      )}
    </AuthCard>
  );
}
