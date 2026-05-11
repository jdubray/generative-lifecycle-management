// Acceptance: kizo:web.todomvc.todo_management.todo_rest_api.spec.acceptance
import { describe, it, expect, beforeEach } from "bun:test";
import { app } from "../src/server";
import { db } from "../src/db";

const wipe = () => db.exec("DELETE FROM todos");

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  wipe();
});

describe("Todo REST API", () => {
  it("GET /api/todos on empty db returns []", async () => {
    const res = await req("/api/todos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/todos with { title: 'buy milk' } returns 201 + Todo with completed=false", async () => {
    const res = await req("/api/todos", json({ title: "buy milk" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("buy milk");
    expect(body.completed).toBe(false);
    expect(typeof body.completed).toBe("boolean");
  });

  it("POST /api/todos with { title: '   ' } returns 422", async () => {
    const res = await req("/api/todos", json({ title: "   " }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("POST /api/todos with malformed JSON returns 400", async () => {
    const res = await req("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/todos missing title returns 400", async () => {
    const res = await req("/api/todos", json({}));
    expect(res.status).toBe(400);
  });

  it("GET /api/todos?filter=active excludes completed", async () => {
    const a = await (await req("/api/todos", json({ title: "a" }))).json();
    await req("/api/todos", json({ title: "b" }));
    await req(`/api/todos/${encodeURIComponent(a.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    const res = await req("/api/todos?filter=active");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("b");
  });

  it("GET /api/todos?filter=bogus returns 400", async () => {
    const res = await req("/api/todos?filter=bogus");
    expect(res.status).toBe(400);
  });

  it("PATCH /api/todos/:id with { completed: true } updates and returns the Todo", async () => {
    const created = await (
      await req("/api/todos", json({ title: "x" }))
    ).json();
    const res = await req(`/api/todos/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.completed).toBe(true);
    expect(typeof body.completed).toBe("boolean");
  });

  it("PATCH /api/todos/:id with empty body returns 400", async () => {
    const created = await (
      await req("/api/todos", json({ title: "x" }))
    ).json();
    const res = await req(`/api/todos/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/todos/missing returns 404", async () => {
    const res = await req("/api/todos/does-not-exist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/todos/:id returns 204 on success", async () => {
    const created = await (
      await req("/api/todos", json({ title: "x" }))
    ).json();
    const res = await req(`/api/todos/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /api/todos/missing returns 404", async () => {
    const res = await req("/api/todos/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /api/todos/toggle-all { completed: true } flips remaining actives, returns { changed: N }", async () => {
    await req("/api/todos", json({ title: "a" }));
    await req("/api/todos", json({ title: "b" }));
    await req("/api/todos", json({ title: "c" }));
    const res = await req(
      "/api/todos/toggle-all",
      json({ completed: true })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(3);

    // Running toggle-all(true) again with everything already true flips 0
    const res2 = await req(
      "/api/todos/toggle-all",
      json({ completed: true })
    );
    expect((await res2.json()).changed).toBe(0);
  });

  it("DELETE /api/todos/completed returns { removed: N }", async () => {
    const a = await (await req("/api/todos", json({ title: "a" }))).json();
    await req("/api/todos", json({ title: "b" }));
    await req(`/api/todos/${encodeURIComponent(a.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    const res = await req("/api/todos/completed", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(1);

    // idempotent: again with zero completed → 0 removed, still 200
    const res2 = await req("/api/todos/completed", { method: "DELETE" });
    expect(res2.status).toBe(200);
    expect((await res2.json()).removed).toBe(0);
  });

  it("GET /healthz returns { ok: true }", async () => {
    const res = await req("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("Every Todo in any successful JSON body has completed as boolean (not 0/1)", async () => {
    await req("/api/todos", json({ title: "a" }));
    const list = await (await req("/api/todos")).json();
    for (const t of list) {
      expect(typeof t.completed).toBe("boolean");
    }
  });
});
