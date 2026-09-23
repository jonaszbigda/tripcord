import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { Invite, Member } from "../types";

const MEMBERS: Member[] = [
  { userId: "user-1", name: "Ana", email: "ana@example.com", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" },
  { userId: "user-2", name: "Mark", email: "mark@example.com", role: "member", joinedAt: "2026-09-02T00:00:00.000Z" },
];
const INVITE: Invite = {
  id: "inv-1",
  role: "member",
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-10T00:00:00.000Z",
  createdByName: "Ana",
};
const AS_MEMBER = { ...ME, orgs: [{ id: ORG_ID, name: "Acme", role: "member" as const }] };

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/members`]: { body: { members: MEMBERS } },
    [`GET /api/orgs/${ORG_ID}/invites`]: { body: { invites: [INVITE] } },
    ...extra,
  };
}

describe("members page", () => {
  it("lets an owner change roles, remove members and manage invites", async () => {
    const calls = mockApi(
      handlers({
        [`PATCH /api/orgs/${ORG_ID}/members/user-2`]: { body: { userId: "user-2", role: "owner" } },
        [`POST /api/orgs/${ORG_ID}/invites`]: {
          status: 201,
          body: { invite: { ...INVITE, id: "inv-2" }, link: "http://localhost:3000/invite/rpi_link" },
        },
        [`DELETE /api/orgs/${ORG_ID}/invites/inv-1`]: { status: 204 },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.selectOptions(await screen.findByLabelText("Role for Mark"), "owner");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "owner" })
    );

    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByText("http://localhost:3000/invite/rpi_link")).toBeInTheDocument();

    expect(screen.getByText(/Created by Ana/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/invites/inv-1"))).toBe(true));
  });

  it("shows a member no owner controls and no invites", async () => {
    const calls = mockApi(handlers({ "GET /api/me": { body: AS_MEMBER } }));
    renderApp(`/orgs/${ORG_ID}/members`);

    expect(await screen.findByText("mark@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Mark")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/invites"))).toBe(false);
  });

  it("lets a member leave, then sends them home", async () => {
    mockApi(
      handlers({
        "GET /api/me": { body: { ...AS_MEMBER, user: { ...AS_MEMBER.user, id: "user-2" } } },
        [`DELETE /api/orgs/${ORG_ID}/members/user-2`]: { status: 204 },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.click(await screen.findByRole("button", { name: "Leave" }));
    await user.click(screen.getByRole("button", { name: "Confirm leave" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/new"));
  });

  it("shows the server's error, e.g. the last-owner rule", async () => {
    mockApi(
      handlers({
        [`PATCH /api/orgs/${ORG_ID}/members/user-1`]: {
          status: 409,
          body: { error: "An org must have at least one owner" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.selectOptions(await screen.findByLabelText("Role for Ana"), "member");

    expect(await screen.findByText("An org must have at least one owner")).toBeInTheDocument();
  });
});
