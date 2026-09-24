import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const PREVIEW = { "GET /api/invites/tpi_tok": { body: { orgName: "Beta", role: "member" } } };

describe("invite page", () => {
  it("lets a logged-in user accept and lands them in the org", async () => {
    const calls = mockApi({
      ...PREVIEW,
      "GET /api/me": { body: ME },
      "POST /api/invites/tpi_tok/accept": { body: { orgId: "org-2" } },
      "GET /api/orgs/org-2/projects": { body: { projects: [] } },
    });
    const user = userEvent.setup();
    renderApp("/invite/tpi_tok");

    expect(await screen.findByRole("heading", { name: "Join Beta" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Accept invite" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/org-2/projects"));
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("offers log in or sign up to a logged-out visitor, carrying the invite", async () => {
    mockApi({ ...PREVIEW, "GET /api/me": { status: 401, body: { error: "Not logged in" } } });
    renderApp("/invite/tpi_tok");

    expect(await screen.findByRole("link", { name: "Log in to accept" })).toHaveAttribute(
      "href",
      "/login?next=%2Finvite%2Ftpi_tok"
    );
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/signup?invite=tpi_tok");
  });

  it("explains an unusable invite", async () => {
    mockApi({
      "GET /api/invites/tpi_tok": { status: 404, body: { error: "Invite not found or expired" } },
      "GET /api/me": { body: ME },
    });
    renderApp("/invite/tpi_tok");
    expect(await screen.findByText("Invite not found or expired")).toBeInTheDocument();
  });

  it("shows 'already a member' from the server", async () => {
    mockApi({
      ...PREVIEW,
      "GET /api/me": { body: ME },
      "POST /api/invites/tpi_tok/accept": { status: 409, body: { error: "Already a member" } },
    });
    const user = userEvent.setup();
    renderApp("/invite/tpi_tok");

    await user.click(await screen.findByRole("button", { name: "Accept invite" }));
    expect(await screen.findByText("Already a member")).toBeInTheDocument();
  });
});
