import { Hono } from "hono";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const PUBLIC_DIR = resolve("./public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const mimeFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
};

const serveFile = (relPath: string): Response | null => {
  const safe = normalize(relPath).replace(/^([./\\])+/, "");
  const abs = join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) return null;
  if (!existsSync(abs)) return null;
  const stat = statSync(abs);
  if (!stat.isFile()) return null;
  const body = readFileSync(abs);
  const contentType = mimeFor(abs);
  const headers: Record<string, string> = { "Content-Type": contentType };
  // Discourage caching of HTML so a stale shell from a prior localhost:3000
  // app cannot stick around in the browser.
  if (contentType.startsWith("text/html")) {
    headers["Cache-Control"] = "no-store, must-revalidate";
  }
  return new Response(body, { status: 200, headers });
};

export const staticRouter = new Hono();

staticRouter.get("/", (c) => {
  const res = serveFile("index.html");
  if (res) return res;
  return c.text("index.html missing", 500);
});

staticRouter.get("/*", (c) => {
  const url = new URL(c.req.url);
  let path = decodeURIComponent(url.pathname);
  if (path === "/" || path === "") path = "/index.html";

  const direct = serveFile(path);
  if (direct) return direct;

  // SPA fallback — index.html for any non-asset, non-API path
  if (!/\.[a-zA-Z0-9]+$/.test(path)) {
    const fallback = serveFile("index.html");
    if (fallback) return fallback;
  }
  return c.notFound();
});
