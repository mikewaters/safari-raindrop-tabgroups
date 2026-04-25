#!/usr/bin/env bun

/**
 * bookmark-index-server — REST API for bookmark-index.
 *
 * Usage: bookmark-index-server [--port N] [--verbose]
 */

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import {
  resolveDbPath,
  openDb,
  loadConfig,
  executeMatch,
  listCollections,
  showCollection,
  type Config,
} from "./lib";
import {
  loadRaindropApiKey,
  findCollection,
  addToCollection,
} from "./raindrop-api";

// ─── Config & DB ────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose");

function log(...msg: unknown[]) {
  if (verbose) console.error("[server]", ...msg);
}

const config = loadConfig();
const apiConfig = config.api;

if (!apiConfig?.token) {
  console.error("API token not configured. Add [api] section to config.toml:");
  console.error('  [api]\n  token = "$BOOKMARK_INDEX_API_TOKEN"\n  port = 8435');
  process.exit(1);
}

let token = apiConfig.token;
if (token.startsWith("$")) {
  token = process.env[token.slice(1)] || "";
}
if (!token) {
  console.error(
    `API token env var ${apiConfig.token} is not set.`,
  );
  process.exit(1);
}

// Parse --port override
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? parseInt(portArg.split("=")[1], 10) : (apiConfig.port || 8435);

const dbPath = resolveDbPath();
const db = openDb(dbPath);
log("database:", dbPath);

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono();

// Auth
// Healthcheck — no auth required
app.get("/healthz", (c) => {
  try {
    db.prepare("SELECT 1").get();
    return c.json({ status: "ok" });
  } catch (err) {
    return c.json({ status: "error", error: (err as Error).message }, 503);
  }
});

app.use("/api/*", bearerAuth({ token }));

// Error handler
app.onError((err, c) => {
  const status = (err as any).status || 500;
  log("error:", err.message);
  return c.json(
    {
      error: err.message,
      status,
      ...(( err as any).suggestions ? { suggestions: (err as any).suggestions } : {}),
    },
    status,
  );
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// Match a URL against collections
app.get("/api/match", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "Missing required query parameter: url", status: 400 }, 400);
  }

  const startMs = Date.now();
  const result = await executeMatch({
    db,
    config,
    url,
    hint: c.req.query("hint") || null,
    topN: parseInt(c.req.query("top") || "5", 10),
    noPrescore: c.req.query("no_prescore") === "1",
    noCache: c.req.query("no_cache") === "1",
    skipFetch: c.req.query("skip_fetch") === "1",
    strategyName: c.req.query("strategy") || "llm-fetch",
    verbose,
    log,
  });

  const durationMs = Date.now() - startMs;
  c.header("X-Match-Duration-Ms", String(durationMs));
  return c.json(result);
});

// List collections
app.get("/api/collections", (c) => {
  const source = c.req.query("source");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;

  const result = listCollections(db, { source, limit, offset });
  return c.json(result);
});

// Show a single collection
app.get("/api/collections/:name", (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const result = showCollection(db, name);
  return c.json(result);
});

// Add a bookmark to a Raindrop collection
app.post("/api/collections/:name/bookmarks", async (c) => {
  const collectionName = decodeURIComponent(c.req.param("name"));
  const body = await c.req.json<{ url: string; title?: string }>();

  if (!body.url) {
    return c.json({ error: "Missing required field: url", status: 400 }, 400);
  }

  let raindropApiKey: string;
  try {
    raindropApiKey = loadRaindropApiKey();
  } catch (err) {
    return c.json({ error: (err as Error).message, status: 500 }, 500);
  }

  const collection = await findCollection(raindropApiKey, collectionName);
  if (!collection) {
    return c.json(
      { ok: false, error: `Collection not found: "${collectionName}"`, status: 404 },
      404,
    );
  }

  const result = await addToCollection(
    raindropApiKey,
    collection._id,
    body.url,
    body.title,
  );
  const item = result.item;

  return c.json({
    ok: true,
    collection: { id: collection._id, title: collection.title },
    raindrop: {
      id: item._id,
      title: item.title,
      link: item.link,
      type: item.type,
    },
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

const cleanup = () => {
  log("Shutting down...");
  db.close();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const host = process.env.HOST || "0.0.0.0";
console.error(`bookmark-index-server listening on http://${host}:${port}`);

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
