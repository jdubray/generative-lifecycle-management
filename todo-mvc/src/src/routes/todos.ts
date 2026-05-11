import { Hono } from "hono";
import { ZodError } from "zod";
import {
  CreateTodoSchema,
  FilterSchema,
  PatchTodoSchema,
  ToggleAllSchema,
} from "./schemas.ts";
import {
  repository,
  ValidationError,
  type Todo,
} from "../repository.ts";

const errorBody = (
  error:
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "validation_failed"
    | "internal_error",
  message: string,
  issues?: unknown[]
) => ({ error, message, ...(issues ? { issues } : {}) });

export const todosRouter = new Hono();

todosRouter.get("/", (c) => {
  const filterQ = c.req.query("filter");
  let filter: "all" | "active" | "completed" = "all";
  if (filterQ !== undefined) {
    const parsed = FilterSchema.safeParse(filterQ);
    if (!parsed.success) {
      return c.json(errorBody("invalid_request", "invalid filter"), 400);
    }
    filter = parsed.data;
  }
  const list: Todo[] = repository.list({ filter });
  return c.json(list, 200);
});

todosRouter.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody("invalid_request", "invalid JSON body"), 400);
  }
  const parsed = CreateTodoSchema.safeParse(raw);
  if (!parsed.success) {
    // distinguish missing-title (400) vs empty-after-trim (422)
    return c.json(
      errorBody("invalid_request", "invalid body", parsed.error.issues),
      400
    );
  }
  try {
    const todo = repository.create({ title: parsed.data.title });
    return c.json(todo, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json(errorBody("validation_failed", err.message), 422);
    }
    throw err;
  }
});

todosRouter.post("/toggle-all", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody("invalid_request", "invalid JSON body"), 400);
  }
  const parsed = ToggleAllSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      errorBody("invalid_request", "invalid body", parsed.error.issues),
      400
    );
  }
  const changed = repository.toggleAll(parsed.data.completed);
  return c.json({ changed }, 200);
});

todosRouter.delete("/completed", (c) => {
  const removed = repository.removeCompleted();
  return c.json({ removed }, 200);
});

todosRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody("invalid_request", "invalid JSON body"), 400);
  }
  let patch;
  try {
    patch = PatchTodoSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      // empty title supplied → 422 instead of 400
      const titleIssue = err.issues.find(
        (i) =>
          i.path.length === 1 &&
          i.path[0] === "title" &&
          (i.code === "too_small" || i.code === "invalid_type")
      );
      if (
        titleIssue &&
        titleIssue.code === "too_small" &&
        (raw as any)?.title !== undefined &&
        typeof (raw as any).title === "string" &&
        (raw as any).title.length === 0
      ) {
        return c.json(errorBody("validation_failed", "empty_title"), 422);
      }
      return c.json(
        errorBody("invalid_request", "invalid body", err.issues),
        400
      );
    }
    throw err;
  }

  // empty-after-trim guard (the schema only catches empty BEFORE trim)
  if (patch.title !== undefined && patch.title.trim().length === 0) {
    return c.json(errorBody("validation_failed", "empty_title"), 422);
  }

  try {
    const todo = repository.update(id, patch);
    if (!todo) return c.json(errorBody("not_found", "todo not found"), 404);
    return c.json(todo, 200);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json(errorBody("validation_failed", err.message), 422);
    }
    throw err;
  }
});

todosRouter.delete("/:id", (c) => {
  const id = c.req.param("id");
  const ok = repository.remove(id);
  if (!ok) return c.json(errorBody("not_found", "todo not found"), 404);
  return c.body(null, 204);
});
