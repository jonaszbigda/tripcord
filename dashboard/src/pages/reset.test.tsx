import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_CLOSED, CONFIG_OPEN } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const LOGGED_OUT = { "GET /api/me": { status: 401, body: { error: "Not logged in" } } };

describe("password reset", () => {
  it("login offers 'Forgot password?' only when the server can send email", async () => {
    mockApi({ ...LOGGED_OUT, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/reset-password");
  });

  it("login hides the link without email", async () => {
    mockApi({ ...LOGGED_OUT, "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/login");
    await screen.findByRole("button", { name: "Log in" });
    expect(screen.queryByRole("link", { name: "Forgot password?" })).not.toBeInTheDocument();
  });

  it("requests a link and says to check email, whether or not the account exists", async () => {
    const calls = mockApi({ ...LOGGED_OUT, "POST /api/auth/password-reset": { status: 204 } });
    const user = userEvent.setup();
    renderApp("/reset-password");

    await user.type(await screen.findByLabelText("Email"), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ email: "ana@example.com" });
  });

  it("sets a new password from the link, then sends the user to log in", async () => {
    const calls = mockApi({
      ...LOGGED_OUT,
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/password-reset/confirm": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_tok");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login?reset=1"));
    expect(await screen.findByText("Password changed. Log in with your new password.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ token: "tpr_tok", newPassword: "new-password" });
  });

  it("won't submit mismatched passwords", async () => {
    mockApi(LOGGED_OUT);
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_tok");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-passw0rd");

    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeDisabled();
  });

  it("explains a dead link and offers a new one", async () => {
    mockApi({
      ...LOGGED_OUT,
      "POST /api/auth/password-reset/confirm": { status: 400, body: { error: "This reset link is invalid or has expired" } },
    });
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_old");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("This reset link is invalid or has expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/reset-password");
  });
});
