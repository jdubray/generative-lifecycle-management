export type FilterMode = "all" | "active" | "completed";

export interface TodoLike {
  completed: boolean;
}

const VALID_MODES: ReadonlySet<string> = new Set(["all", "active", "completed"]);

export function filter<T extends TodoLike>(mode: FilterMode, todos: T[]): T[] {
  if (!VALID_MODES.has(mode as string)) {
    throw new TypeError(`Unknown filter mode: ${String(mode)}`);
  }
  if (mode === "all") return todos.slice();
  if (mode === "active") return todos.filter((t) => !t.completed);
  return todos.filter((t) => t.completed);
}

export function countActive<T extends TodoLike>(todos: T[]): number {
  return filter("active", todos).length;
}

export function countCompleted<T extends TodoLike>(todos: T[]): number {
  return filter("completed", todos).length;
}
