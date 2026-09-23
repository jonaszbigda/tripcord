import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { LOGIN_ERRORS, githubHref, inviteTokenFromNext, safeNext } from "../auth";
import { Alert, AuthCard, Button, ErrorText, TextField } from "../components/ui";
import { queryKeys, useAuthConfig } from "../queries";
import type { Me } from "../types";

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const inviteToken = inviteTokenFromNext(next);
  const errorCode = params.get("error");
  const config = useAuthConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api<Me>("POST", "/api/auth/login", { email, password }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      navigate(next ?? "/", { replace: true });
    },
  });

  const canSignUp =
    config.data && (config.data.signup === "open" || !config.data.bootstrapped || inviteToken !== undefined);

  return (
    <AuthCard title="Log in">
      {errorCode && <Alert>{LOGIN_ERRORS[errorCode] ?? "Something went wrong. Please try again."}</Alert>}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />
        <ErrorText error={login.error} />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          Log in
        </Button>
      </form>
      {config.data?.github && (
        <a
          href={githubHref("login", inviteToken)}
          className="flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
        >
          Continue with GitHub
        </a>
      )}
      {canSignUp && (
        <p className="text-sm text-muted">
          No account?{" "}
          <Link className="text-accent hover:underline" to={inviteToken ? `/signup?invite=${inviteToken}` : "/signup"}>
            Sign up
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
