import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

// The server answers 204 whether or not the address has an account, so this
// page says the same thing either way.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const request = useMutation({ mutationFn: () => api("POST", "/api/auth/password-reset", { email }) });

  if (request.isSuccess) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-muted">
          If {email} has an account, we've sent it a link to choose a new password. The link works for one hour.
        </p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Back to log in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate();
        }}
      >
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <ErrorText error={request.error} />
        <Button type="submit" className="w-full" disabled={request.isPending}>
          Send reset link
        </Button>
      </form>
      <Link className="text-sm text-accent hover:underline" to="/login">
        Back to log in
      </Link>
    </AuthCard>
  );
}
