import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const PROJECT = { id: "p-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const MEMBER_ME = { ...ME, orgs: [{ ...ME.orgs[0], role: "member" as const }] };

describe("project settings", () => {
  it("links the NDJSON export", async () => {
    mockApi({ "GET /api/me": { body: ME }, [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } } });
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);
    expect(await screen.findByRole("link", { name: "Export timelines" })).toHaveAttribute(
      "href",
      `/api/orgs/${ORG_ID}/projects/p-1/export`
    );
  });

  it("an owner deletes the project after typing its name", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
      [`DELETE /api/orgs/${ORG_ID}/projects/p-1`]: { status: 204 },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);

    const button = await screen.findByRole("button", { name: "Delete project" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Type "web" to confirm'), "web");
    await user.click(button);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("a member can export but not delete", async () => {
    mockApi({ "GET /api/me": { body: MEMBER_ME }, [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } } });
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);
    expect(await screen.findByText("Only owners can delete a project.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
  });
});

describe("org settings", () => {
  it("an owner deletes the org after typing its name and leaves it", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`DELETE /api/orgs/${ORG_ID}`]: { status: 204 },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/settings`);

    await user.type(await screen.findByLabelText('Type "Acme" to confirm'), "Acme");
    await user.click(screen.getByRole("button", { name: "Delete organization" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/new"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("account settings", () => {
  it("deletes the account with the password and goes to login", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ password: "correct horse" });
  });

  it("a GitHub-only user confirms by typing their email", async () => {
    const calls = mockApi({
      "GET /api/me": { body: { ...ME, user: { ...ME.user, hasPassword: false, githubConnected: true } } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText('Type "ana@example.com" to confirm'), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({}));
  });

  it("lists the orgs that block deletion", async () => {
    mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": {
        status: 409,
        body: { error: "You're the only owner of an org with other members", orgs: [{ id: ORG_ID, name: "Acme" }] },
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    expect(await screen.findByRole("link", { name: "Acme" })).toHaveAttribute("href", `/orgs/${ORG_ID}/members`);
  });
});
