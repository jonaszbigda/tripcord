import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { githubHref } from "../auth";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";
import { queryKeys, useAuthConfig } from "../queries";
import type { Me } from "../types";

export function SignupPage() {
  const [params] = useSearchParams();
  const inviteToken = params.get("invite") ?? undefined;
  const config = useAuthConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signup = useMutation({
    mutationFn: () => api<Me>("POST", "/api/auth/signup", { name, email, password, inviteToken }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      navigate("/", { replace: true });
    },
  });

  const closed =
    config.data && config.data.signup === "invite-only" && config.data.bootstrapped && inviteToken === undefined;
  const loginLink = inviteToken ? `/login?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : "/login";

  if (closed) {
    return (
      <AuthCard title="Signup is invite-only">
        <p className="text-sm text-muted">Ask an organization owner for an invite link.</p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Back to log in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={inviteToken ? "Create an account to join" : "Create your account"}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          signup.mutate();
        }}
      >
        <TextField label="Name" autoComplete="name" value={name} onChange={setName} required maxLength={100} />
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          maxLength={256}
        />
        <ErrorText error={signup.error} />
        <Button type="submit" className="w-full" disabled={signup.isPending}>
          Sign up
        </Button>
      </form>
      {config.data?.github && (
        <a
          href={githubHref("login", inviteToken)}
          className="flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
        >
          Sign up with GitHub
        </a>
      )}
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link className="text-accent hover:underline" to={loginLink}>
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}
