import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { ApiKey, Project } from "../types";

const PROJECT: Project = { id: "proj-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const KEY: ApiKey = { id: "key-1", projectId: "proj-1", prefix: "tpk_AbCdEfGh", createdAt: "2026-09-01T00:00:00.000Z", revokedAt: null };

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/keys`]: { body: { keys: [KEY] } },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines`]: { body: { timelines: [], nextCursor: null } },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines/summary`]: {
      body: { projectHasTimelines: false, bucket: "day", buckets: [], topReasons: [] },
    },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines/tags`]: { body: { tags: [] } },
    ...extra,
  };
}

const location = () => screen.getByTestId("location");

describe("projects page", () => {
  it("lists the org's projects", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects`);
    expect(await screen.findByRole("link", { name: "web" })).toHaveAttribute("href", `/orgs/${ORG_ID}/projects/proj-1`);
  });

  it("creates a project and shows its key until dismissed", async () => {
    const calls = mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects`]: {
          status: 201,
          body: { project: { id: "proj-2", orgId: ORG_ID, name: "api", createdAt: PROJECT.createdAt }, key: "tpk_created" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.type(await screen.findByLabelText("New project name"), "api");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("tpk_created")).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "api" });

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("tpk_created")).not.toBeInTheDocument();
  });

  it("says so when the user isn't a member of the org", async () => {
    mockApi(handlers());
    renderApp("/orgs/someone-elses/projects");
    expect(await screen.findByRole("heading", { name: "Organization not found" })).toBeInTheDocument();
  });
});

describe("project page", () => {
  it("shows the ingest endpoint and the key prefixes", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects/proj-1/keys`);

    expect(await screen.findByRole("heading", { name: "web" })).toBeInTheDocument();
    expect(screen.getByText(/\/v1\/timeline$/)).toBeInTheDocument();
    expect(await screen.findByText("tpk_AbCdEfGh…")).toBeInTheDocument();
  });

  it("shows a new key once; it's gone after navigating away and back", async () => {
    mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects/proj-1/keys`]: {
          status: 201,
          body: { apiKey: { ...KEY, id: "key-2", prefix: "tpk_Second12" }, key: "tpk_second_full_key" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1/keys`);

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    expect(await screen.findByText("tpk_second_full_key")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Projects" }));
    await user.click(await screen.findByRole("link", { name: "web" }));
    await user.click(await screen.findByRole("link", { name: "Keys" }));
    await screen.findByText("tpk_AbCdEfGh…");
    expect(screen.queryByText("tpk_second_full_key")).not.toBeInTheDocument();
  });

  it("revokes a key only after confirmation", async () => {
    const calls = mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects/proj-1/keys/key-1/revoke`]: {
          body: { apiKey: { ...KEY, revokedAt: "2026-09-02T00:00:00.000Z" }, alreadyRevoked: false },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1/keys`);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/key-1/revoke"))).toBe(true));
  });

  it("opens on the Timelines tab and switches to Keys", async () => {
    mockApi(handlers());
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1`);

    expect(await screen.findByRole("heading", { name: "web" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Timelines" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Keys" }));
    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects/proj-1/keys`));
    expect(await screen.findByText("tpk_AbCdEfGh…")).toBeInTheDocument();
  });

  it("says so for a project that isn't in the org", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects/nope`);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
  });
});

describe("app shell", () => {
  it("switches orgs and offers creating a new one", async () => {
    mockApi(
      handlers({
        "GET /api/me": { body: { ...ME, orgs: [...ME.orgs, { id: "org-2", name: "Beta", role: "member" }] } },
        "GET /api/orgs/org-2/projects": { body: { projects: [] } },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.selectOptions(await screen.findByLabelText("Organization"), "Beta");
    await waitFor(() => expect(location()).toHaveTextContent("/orgs/org-2/projects"));

    await user.selectOptions(screen.getByLabelText("Organization"), "+ New organization…");
    await waitFor(() => expect(location()).toHaveTextContent("/orgs/new"));
  });

  it("logs out", async () => {
    const calls = mockApi(handlers({ "POST /api/auth/logout": { status: 204 }, "GET /api/auth/config": { body: { signup: "open", bootstrapped: true, github: false } } }));
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(location()).toHaveTextContent(/^\/login/));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/auth/logout")).toBe(true);
  });
});
