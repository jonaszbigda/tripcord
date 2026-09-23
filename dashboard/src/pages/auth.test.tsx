import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_CLOSED, CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const location = () => screen.getByTestId("location");

describe("login", () => {
  it("logs in and lands on the first org's projects", async () => {
    const calls = mockApi({
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/login": { body: ME },
    });
    const user = userEvent.setup();
    renderApp("/login");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      email: "ana@example.com",
      password: "long-password",
    });
  });

  it("shows the server's error for bad credentials", async () => {
    mockApi({
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/login": { status: 401, body: { error: "Invalid email or password" } },
    });
    const user = userEvent.setup();
    renderApp("/login");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    expect(location()).toHaveTextContent("/login");
  });

  it("offers signup and GitHub only when the instance allows them", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github?intent=login"
    );
  });

  it("hides signup and GitHub on a bootstrapped invite-only instance", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/login");
    await screen.findByRole("button", { name: "Log in" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Sign up" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).not.toBeInTheDocument();
  });

  it("carries an invite through to signup and after login", async () => {
    mockApi({
      "GET /api/auth/config": { body: CONFIG_CLOSED },
      "POST /api/auth/login": { body: ME },
    });
    const user = userEvent.setup();
    renderApp("/login?next=%2Finvite%2Frpi_abc");

    expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup?invite=rpi_abc");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(location()).toHaveTextContent("/invite/rpi_abc"));
  });

  it("ignores an off-site next parameter", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN }, "POST /api/auth/login": { body: ME } });
    const user = userEvent.setup();
    renderApp("/login?next=%2F%2Fevil.example");

    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
  });

  it("explains a GitHub error code", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login?error=github_email_exists");
    expect(await screen.findByRole("alert")).toHaveTextContent("An account with this email already exists");
  });
});

describe("signup", () => {
  it("signs up with the invite token from the URL", async () => {
    const calls = mockApi({
      "GET /api/auth/config": { body: CONFIG_CLOSED },
      "POST /api/auth/signup": { status: 201, body: ME },
    });
    const user = userEvent.setup();
    renderApp("/signup?invite=rpi_abc");

    await user.type(await screen.findByLabelText("Name"), "Ana");
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Ana",
      email: "ana@example.com",
      password: "long-password",
      inviteToken: "rpi_abc",
    });
  });

  it("says signup is closed on a bootstrapped invite-only instance", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/signup");
    expect(await screen.findByRole("heading", { name: "Signup is invite-only" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
  });
});

describe("logged-in routes", () => {
  it("send a logged-out visitor to login, remembering where they were going", async () => {
    mockApi({
      "GET /api/me": { status: 401, body: { error: "Not logged in" } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
    });
    renderApp("/orgs/new");
    await waitFor(() => expect(location()).toHaveTextContent("/login?next=%2Forgs%2Fnew"));
  });

  it("send a user without orgs to create one", async () => {
    mockApi({
      "GET /api/me": { body: { ...ME, orgs: [] } },
      "POST /api/orgs": { status: 201, body: { id: "org-9", name: "Beta", role: "owner" } },
    });
    const user = userEvent.setup();
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Create your organization" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Organization name"), "Beta");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(location()).toHaveTextContent("/orgs/org-9/projects"));
  });
});
