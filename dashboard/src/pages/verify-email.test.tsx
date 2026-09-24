import { describe, it, expect } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID, UNVERIFIED_ME } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";

const location = () => screen.getByTestId("location");

describe("unverified email", () => {
  it("shows only the check-your-inbox page, keeping the URL", async () => {
    mockApi({ "GET /api/me": { body: UNVERIFIED_ME } });
    renderApp(`/orgs/${ORG_ID}/projects`);

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`);
  });

  it("resends, and shows the wait after a 429", async () => {
    const handlers: Record<string, MockHandler> = {
      "GET /api/me": { body: UNVERIFIED_ME },
      "POST /api/me/verify-email/resend": { status: 204 },
    };
    const calls = mockApi(handlers);
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Resend email" }));
    expect(await screen.findByText("Sent. Check your inbox and spam folder.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/me/verify-email/resend")).toHaveLength(1);

    handlers["POST /api/me/verify-email/resend"] = {
      status: 429,
      body: { error: "Too many verification emails", retryAfterSeconds: 90 },
    };
    await user.click(screen.getByRole("button", { name: "Resend email" }));
    expect(await screen.findByText(/You can resend in 90 s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend email" })).toBeDisabled();
  });

  it("fixes a typo'd address", async () => {
    let me = UNVERIFIED_ME;
    const calls = mockApi({
      "GET /api/me": () => ({ body: me }),
      "PATCH /api/me/email": (body) => {
        me = { ...me, user: { ...me.user, email: (body as { email: string }).email } };
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Wrong address?" }));
    await user.type(screen.getByLabelText("New email"), "ana@example.org");
    await user.click(screen.getByRole("button", { name: "Change and resend" }));

    expect(await screen.findByText("ana@example.org")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ email: "ana@example.org" });
  });

  it("shows the server's error when the address is taken", async () => {
    mockApi({
      "GET /api/me": { body: UNVERIFIED_ME },
      "PATCH /api/me/email": { status: 409, body: { error: "Email already registered" } },
    });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Wrong address?" }));
    await user.type(screen.getByLabelText("New email"), "taken@example.com");
    await user.click(screen.getByRole("button", { name: "Change and resend" }));

    expect(await screen.findByText("Email already registered")).toBeInTheDocument();
  });

  it("unlocks the app when the tab regains focus after verifying elsewhere", async () => {
    let me = UNVERIFIED_ME;
    mockApi({
      "GET /api/me": () => ({ body: me }),
      "GET /api/orgs/org-1/projects": { body: { projects: [] } },
    });
    renderApp(`/orgs/${ORG_ID}/projects`);
    await screen.findByRole("heading", { name: "Check your inbox" });

    me = ME;
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Check your inbox" })).not.toBeInTheDocument());
  });

  it("a 403 'Email not verified' from any request brings the page up", async () => {
    let me = ME;
    mockApi({
      "GET /api/me": () => ({ body: me }),
      "GET /api/orgs/org-1/projects": () => {
        me = UNVERIFIED_ME;
        return { status: 403, body: { error: "Email not verified" } };
      },
    });
    renderApp(`/orgs/${ORG_ID}/projects`);

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
  });
});
