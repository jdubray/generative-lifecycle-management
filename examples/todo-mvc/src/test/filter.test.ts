// Acceptance: kizo:web.todomvc.todo_management.todo_filter_engine.spec.acceptance
import { describe, it, expect } from "bun:test";
import { filter, countActive, countCompleted } from "../src/filter";

interface T {
  id: string;
  completed: boolean;
}

const mixed: T[] = [
  { id: "a", completed: false },
  { id: "b", completed: true },
  { id: "c", completed: false },
  { id: "d", completed: true },
  { id: "e", completed: false },
];

describe("Todo Filter Engine", () => {
  it("filter('all', xs) deep-equals xs", () => {
    expect(filter("all", mixed)).toEqual(mixed);
  });

  it("filter('active', mixed) returns only completed=false rows in input order", () => {
    const out = filter("active", mixed);
    expect(out.map((t) => t.id)).toEqual(["a", "c", "e"]);
    expect(out.every((t) => t.completed === false)).toBe(true);
  });

  it("filter('completed', mixed) returns only completed=true rows in input order", () => {
    const out = filter("completed", mixed);
    expect(out.map((t) => t.id)).toEqual(["b", "d"]);
    expect(out.every((t) => t.completed === true)).toBe(true);
  });

  it("filter('bogus', xs) throws TypeError", () => {
    expect(() => filter("bogus" as any, mixed)).toThrow(TypeError);
  });

  it("filter does not mutate the input array", () => {
    const snapshot = mixed.map((t) => ({ ...t }));
    filter("active", mixed);
    filter("completed", mixed);
    filter("all", mixed);
    expect(mixed).toEqual(snapshot);
  });

  it("countActive(mixed) === filter('active', mixed).length", () => {
    expect(countActive(mixed)).toBe(filter("active", mixed).length);
    expect(countCompleted(mixed)).toBe(filter("completed", mixed).length);
  });

  it("filter('active') ∪ filter('completed') == filter('all') (order preserved)", () => {
    const active = filter("active", mixed);
    const completed = filter("completed", mixed);
    const union = [...active, ...completed];

    // every Todo lands in exactly one bucket → counts add up
    expect(active.length + completed.length).toBe(mixed.length);

    // ordered union covers all elements (set equality)
    const unionIds = new Set(union.map((t) => t.id));
    const allIds = new Set(mixed.map((t) => t.id));
    expect(unionIds).toEqual(allIds);

    // active and completed are each order-preserving sub-sequences of mixed
    const idsInOrder = mixed.map((t) => t.id);
    const activeIdsInOrder = active.map((t) => t.id);
    const completedIdsInOrder = completed.map((t) => t.id);
    expect(idsInOrder.filter((id) => activeIdsInOrder.includes(id))).toEqual(
      activeIdsInOrder
    );
    expect(idsInOrder.filter((id) => completedIdsInOrder.includes(id))).toEqual(
      completedIdsInOrder
    );
  });
});
