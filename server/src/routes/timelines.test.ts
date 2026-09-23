import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestProject,
  createTestUser,
  getTestDb,
  insertTestTimeline,
  resetDb,
  sessionCookie,
} from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const member = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  await addMember(db, org.id, member.id, "member");
  const { project } = await createTestProject(db, "web", org.id);
  const { project: sibling } = await createTestProject(db, "api", org.id);
  const app = await buildTestApp(db);
  return {
    db,
    app,
    project,
    sibling,
    // Members (not just owners) read timelines.
    cookie: await sessionCookie(db, member.id),
    base: `/api/orgs/${org.id}/projects/${project.id}/timelines`,
  };
}

describe("timeline read routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("lists timelines, taking repeated and single-valued array params", async () => {
    const { db, app, project, cookie, base } = await fixture();
    const tagged = await insertTestTimeline(db, project.id, { tags: ["checkout"] });
    await insertTestTimeline(db, project.id, { reason: { type: "manual", name: "m" }, tags: ["video_player"] });

    const both = await call(app, "GET", `${base}?reasonType=error&reasonType=manual&tag=checkout`, { cookie });
    expect(both.statusCode).toBe(200);
    expect(both.json().timelines.map((t: { id: string }) => t.id)).toEqual([tagged]);

    const single = await call(app, "GET", `${base}?reasonType=manual`, { cookie });
    expect(single.json().timelines).toHaveLength(1);
  });

  it("pages with nextCursor", async () => {
    const { db, app, project, cookie, base } = await fixture();
    for (let i = 0; i < 3; i++) {
      await insertTestTimeline(db, project.id);
    }

    const first = (await call(app, "GET", `${base}?limit=2`, { cookie })).json();
    expect(first.timelines).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await call(app, "GET", `${base}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { cookie })).json();
    expect(second.timelines).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    "range=1y",
    "reasonType=fatal",
    "tag=Checkout",
    "reason=abc",
    "limit=0",
    "limit=101",
    "cursor=garbage",
    "unknown=1",
  ])("returns 400 for ?%s", async (query) => {
    const { app, cookie, base } = await fixture();
    const response = await call(app, "GET", `${base}?${query}`, { cookie });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
  });

  it("summarizes in the requested time zone and rejects an unknown one", async () => {
    const { db, app, project, cookie, base } = await fixture();
    await insertTestTimeline(db, project.id);

    const bad = await call(app, "GET", `${base}/summary?tz=Not%2FA_Zone`, { cookie });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "Invalid time zone" });

    const good = await call(app, "GET", `${base}/summary?tz=Europe%2FWarsaw`, { cookie });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ projectHasTimelines: true, bucket: "day" });
    expect(good.json().buckets).toHaveLength(8);
    expect(good.json().topReasons).toHaveLength(1);
  });

  it("lists tags, and takes only range", async () => {
    const { db, app, project, cookie, base } = await fixture();
    await insertTestTimeline(db, project.id, { tags: ["checkout"] });

    const response = await call(app, "GET", `${base}/tags?range=24h`, { cookie });
    expect(response.json()).toEqual({ tags: [{ tag: "checkout", count: 1 }] });

    expect((await call(app, "GET", `${base}/tags?reasonType=error`, { cookie })).statusCode).toBe(400);
  });

  it("returns one timeline, and 404 for a malformed id or another project's timeline", async () => {
    const { db, app, project, sibling, cookie, base } = await fixture();
    const id = await insertTestTimeline(db, project.id);
    const theirs = await insertTestTimeline(db, sibling.id);

    const found = await call(app, "GET", `${base}/${id}`, { cookie });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ timeline: { id }, siblings: [] });

    for (const bad of ["not-a-uuid", theirs]) {
      const response = await call(app, "GET", `${base}/${bad}`, { cookie });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
  });

  it("requires a session", async () => {
    const { app, base } = await fixture();
    expect((await call(app, "GET", base)).statusCode).toBe(401);
  });
});
