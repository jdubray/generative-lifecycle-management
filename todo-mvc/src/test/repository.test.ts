// Acceptance: kizo:web.todomvc.todo_management.todo_repository.spec.acceptance
import { describe, it, expect, beforeEach } from "bun:test";
import {
  TodoRepository,
  ValidationError,
} from "../src/repository";
import { db } from "../src/db";

const repo = new TodoRepository();

const wipe = () => db.exec("DELETE FROM todos");

beforeEach(() => {
  wipe();
});

describe("Todo Repository", () => {
  it("create returns a Todo with completed=false and a non-empty id", () => {
    const t = repo.create({ title: "buy milk" });
    expect(t.completed).toBe(false);
    expect(typeof t.id).toBe("string");
    expect(t.id.length).toBeGreaterThan(0);
    expect(t.title).toBe("buy milk");
  });

  it("list() returns rows in created_at ASC order", async () => {
    repo.create({ title: "first" });
    await Bun.sleep(3);
    repo.create({ title: "second" });
    await Bun.sleep(3);
    repo.create({ title: "third" });
    const list = repo.list();
    expect(list.map((t) => t.title)).toEqual(["first", "second", "third"]);
  });

  it("list({ filter: 'active' }) excludes completed rows", () => {
    const a = repo.create({ title: "a" });
    repo.create({ title: "b" });
    repo.update(a.id, { completed: true });
    const active = repo.list({ filter: "active" });
    expect(active.length).toBe(1);
    expect(active[0].title).toBe("b");
  });

  it("list({ filter: 'completed' }) excludes active rows", () => {
    const a = repo.create({ title: "a" });
    repo.create({ title: "b" });
    repo.update(a.id, { completed: true });
    const completed = repo.list({ filter: "completed" });
    expect(completed.length).toBe(1);
    expect(completed[0].title).toBe("a");
    expect(completed[0].completed).toBe(true);
  });

  it("get(missing_id) returns null", () => {
    expect(repo.get("definitely-not-real")).toBeNull();
  });

  it("update advances updated_at by at least 1 ms", async () => {
    const t = repo.create({ title: "x" });
    const before = t.updated_at;
    await Bun.sleep(5);
    const updated = repo.update(t.id, { title: "y" });
    expect(updated).not.toBeNull();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(
      new Date(before).getTime()
    );
  });

  it("update with no fields returns the current row unchanged (except possibly updated_at)", () => {
    const t = repo.create({ title: "noop" });
    const after = repo.update(t.id, {});
    expect(after).not.toBeNull();
    expect(after!.id).toBe(t.id);
    expect(after!.title).toBe(t.title);
    expect(after!.completed).toBe(t.completed);
  });

  it("remove(missing_id) returns false", () => {
    expect(repo.remove("not-here")).toBe(false);
  });

  it("deleteCompleted twice in a row removes once then is a no-op", () => {
    const a = repo.create({ title: "a" });
    repo.create({ title: "b" });
    repo.update(a.id, { completed: true });

    expect(repo.removeCompleted()).toBe(1);
    expect(repo.removeCompleted()).toBe(0);
    expect(repo.list().length).toBe(1);
  });

  it("toggleAll(true) flips only the active todos and returns their count", () => {
    const a = repo.create({ title: "a" });
    repo.create({ title: "b" });
    repo.create({ title: "c" });
    repo.update(a.id, { completed: true });

    expect(repo.toggleAll(true)).toBe(2);
    // running toggleAll(true) again should flip zero rows (no-op when all already match)
    expect(repo.toggleAll(true)).toBe(0);
    expect(repo.list().every((t) => t.completed)).toBe(true);
  });

  it("title='   ' (whitespace only) → ValidationError on create", () => {
    expect(() => repo.create({ title: "   " })).toThrow(ValidationError);
  });

  it("invariant: after a successful create, get(id) returns the same row", () => {
    const t = repo.create({ title: "round-trip" });
    expect(repo.get(t.id)).toEqual(t);
  });
});
