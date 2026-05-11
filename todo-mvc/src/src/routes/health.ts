import { Hono } from "hono";

export const healthRouter = new Hono();

healthRouter.get("/healthz", (c) => c.json({ ok: true }, 200));
