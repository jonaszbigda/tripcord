import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

describe("user settings", () => {
  it("changes the password with the current one", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/me/password": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/me/password")?.body).toEqual({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
  });

  it("lets a GitHub-only user set a first password without a current one", async () => {
    mockApi({
      "GET /api/me": { body: { ...ME, user: { ...ME.user, hasPassword: false, githubConnected: true } } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
    });
    renderApp("/settings");

    expect(await screen.findByRole("button", { name: "Set password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeDisabled();
  });

  it("offers to connect GitHub when it's enabled", async () => {
    mockApi({ "GET /api/me": { body: ME }, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/settings");
    expect(await screen.findByRole("link", { name: "Connect GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github?intent=connect"
    );
  });

  it("explains a GitHub connect error", async () => {
    mockApi({ "GET /api/me": { body: ME }, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/settings?error=github_taken");
    expect(await screen.findByRole("alert")).toHaveTextContent("already linked to another user");
  });
});

describe("org settings", () => {
  it("lets an owner rename the org", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`PATCH /api/orgs/${ORG_ID}`]: { body: { id: ORG_ID, name: "Acme Inc" } },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/settings`);

    const field = await screen.findByLabelText("Organization name");
    await user.clear(field);
    await user.type(field, "Acme Inc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByLabelText("Organization")).toHaveDisplayValue("Acme Inc"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Acme Inc" });
  });
});
