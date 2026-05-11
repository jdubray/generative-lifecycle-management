import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { todosRouter } from "./routes/todos.ts";
import { healthRouter } from "./routes/health.ts";
import { staticRouter } from "./routes/static.ts";

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const REQUEST_LOGGING = (process.env.REQUEST_LOGGING ?? "true") === "true";

export const app = new Hono();

app.use("*", cors({ origin: CORS_ORIGIN }));
if (REQUEST_LOGGING) app.use("*", logger());

app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "internal_error", message: "internal error" }, 500);
});

app.route("/api/todos", todosRouter);
app.route("/", healthRouter);
app.route("/", staticRouter);

if (import.meta.main) {
  Bun.serve({
    port: SERVER_PORT,
    fetch: app.fetch,
  });
  console.log(`TodoMVC server listening on http://localhost:${SERVER_PORT}`);
}
