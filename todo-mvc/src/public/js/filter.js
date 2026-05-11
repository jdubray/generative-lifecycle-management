// Mirror of src/filter.ts — pure, no side effects.
const VALID_MODES = new Set(["all", "active", "completed"]);

export function filter(mode, todos) {
  if (!VALID_MODES.has(mode)) {
    throw new TypeError(`Unknown filter mode: ${String(mode)}`);
  }
  if (mode === "all") return todos.slice();
  if (mode === "active") return todos.filter((t) => !t.completed);
  return todos.filter((t) => t.completed);
}

export function countActive(todos) {
  return filter("active", todos).length;
}

export function countCompleted(todos) {
  return filter("completed", todos).length;
}
