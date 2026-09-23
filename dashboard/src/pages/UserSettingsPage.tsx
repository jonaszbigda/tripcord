import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { SETTINGS_ERRORS, githubHref } from "../auth";
import { Alert, Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { queryKeys, useAuthConfig, useMe } from "../queries";

export function UserSettingsPage() {
  const me = useMe().data!;
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const errorCode = params.get("error");
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const changePassword = useMutation({
    mutationFn: () =>
      api("POST", "/api/me/password", {
        ...(me.user.hasPassword ? { currentPassword } : {}),
        newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api("DELETE", "/api/me/github"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Your account" />
      {errorCode && <Alert>{SETTINGS_ERRORS[errorCode] ?? "Something went wrong. Please try again."}</Alert>}

      <Card className="space-y-1 text-sm">
        <p className="font-medium">{me.user.name}</p>
        <p className="text-muted">{me.user.email}</p>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">{me.user.hasPassword ? "Change password" : "Set a password"}</h2>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            changePassword.mutate();
          }}
        >
          {me.user.hasPassword && (
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
              required
            />
          )}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            required
            minLength={8}
            maxLength={256}
          />
          <ErrorText error={changePassword.error} />
          {changePassword.isSuccess && <p className="text-sm text-muted">Password updated.</p>}
          <Button type="submit" disabled={changePassword.isPending}>
            {me.user.hasPassword ? "Change password" : "Set password"}
          </Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">GitHub</h2>
        {me.user.githubConnected ? (
          <>
            <p className="text-sm text-muted">Connected. You can log in with GitHub.</p>
            {!me.user.hasPassword && (
              <p className="text-sm text-muted">Set a password first, so you can still log in after disconnecting.</p>
            )}
            <ErrorText error={disconnect.error} />
            <Button
              variant="secondary"
              onClick={() => disconnect.mutate()}
              disabled={!me.user.hasPassword || disconnect.isPending}
            >
              Disconnect GitHub
            </Button>
          </>
        ) : config.data?.github ? (
          <a
            href={githubHref("connect")}
            className="inline-flex rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
          >
            Connect GitHub
          </a>
        ) : (
          <p className="text-sm text-muted">GitHub login isn't enabled on this instance.</p>
        )}
      </Card>
    </div>
  );
}
