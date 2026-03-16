#!/usr/bin/env bun

/**
 * Syncs cached Raindrop.io collection and bookmark data.
 * Supports delta syncs via ETags and last-update timestamps.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";
import { resolveConfigPath } from "./config.ts";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`raindrop-sync — Refresh cached Raindrop.io data

Usage: raindrop-sync [options]

Options:
  --full       Force a full sync (ignore delta cache)
  --check      Check if a sync is needed without performing it
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message`);
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose") || args.has("--debug");
const forceFullRaindrop = args.has("--full");
const checkOnly = args.has("--check");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

const home = homedir();
const cacheBase = process.env.XDG_CACHE_HOME || join(home, ".cache");
const cacheDir = join(cacheBase, "safari-tabgroups");
mkdirSync(cacheDir, { recursive: true });

// --- Raindrop API ---

const RAINDROP_BASE = "https://api.raindrop.io/rest/v1";
let raindropHeaders: Record<string, string> = {};

interface ApiResult<T> {
  data: T | null;
  etag?: string;
}

async function raindropApi<T>(path: string, opts?: { etag?: string }): Promise<ApiResult<T>> {
  const url = `${RAINDROP_BASE}${path}`;
  const headers: Record<string, string> = { ...raindropHeaders };
  if (opts?.etag) {
    headers["If-None-Match"] = opts.etag;
    log("GET", url, "(conditional)");
  } else {
    log("GET", url);
  }
  const res = await fetch(url, { headers });
  if (res.status === 304) {
    log("304 Not Modified:", path);
    return { data: null, etag: opts?.etag };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  const etag = res.headers.get("etag") || undefined;
  if (etag) log("ETag:", etag);
  const data = await res.json() as T;
  return { data, etag };
}

async function raindropApiSimple<T>(path: string): Promise<T> {
  const result = await raindropApi<T>(path);
  return result.data!;
}

function collectionFingerprint(collections: any[]): string {
  const sorted = [...collections].sort((a: any, b: any) => a._id - b._id);
  const sig = sorted.map((c: any) => `${c._id}:${c.lastUpdate}:${c.count}`).join("|");
  return new Bun.CryptoHasher("md5").update(sig).digest("hex");
}

interface RaindropCache {
  fetchedAt: string;
  collections: any[];
  raindrops: any[];
  groups?: Array<{ title: string; collections: number[] }>;
  collectionsETag?: string;
  childrensETag?: string;
  collectionsFingerprint?: string;
}

function mergeRaindrops(existing: any[], updates: any[]): any[] {
  const byId = new Map<number, any>();
  for (const item of existing) {
    if (item && typeof item._id === "number") byId.set(item._id, item);
  }
  for (const item of updates) {
    if (item && typeof item._id === "number") byId.set(item._id, item);
  }
  return [...byId.values()];
}

async function fetchAllRaindrops(search?: string): Promise<any[]> {
  const all: any[] = [];
  let page = 0;
  while (true) {
    const query = new URLSearchParams({
      perpage: "50",
      page: String(page),
    });
    if (search) query.set("search", search);
    const data = await raindropApiSimple<{ items: any[] }>(
      `/raindrops/0?${query.toString()}`
    );
    if (data.items.length === 0) break;
    all.push(...data.items);
    log(
      `Fetched page ${page}: ${data.items.length} raindrop(s)${
        search ? " (delta)" : ""
      }`
    );
    if (data.items.length < 50) break;
    page++;
  }
  return all;
}

function loadConfig() {
  const configPath = resolveConfigPath();
  log("config:", configPath);

  interface RaindropConfig { api_key: string; }
  let config: RaindropConfig;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as { raindrop: RaindropConfig };
    config = parsed.raindrop;
  } catch (err) {
    throw new Error(`Failed to load config from ${configPath}: ${err}`);
  }

  let apiKey = config.api_key;
  if (apiKey.startsWith("$")) {
    apiKey = process.env[apiKey.slice(1)] || "";
  }
  if (!apiKey) {
    throw new Error(
      "Raindrop API key not set. Configure api_key in fetch.config.toml or set the RAINDROP_TOKEN environment variable."
    );
  }

  return apiKey;
}

async function syncRaindrop() {
  const apiKey = loadConfig();
  raindropHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const cacheFile = join(cacheDir, "raindrop-collections.json");
  let previousCache: RaindropCache | null = null;
  if (existsSync(cacheFile) && !forceFullRaindrop) {
    try {
      previousCache = JSON.parse(readFileSync(cacheFile, "utf-8")) as RaindropCache;
    } catch (err) {
      log("Failed to parse Raindrop cache, falling back to full sync:", err);
      previousCache = null;
    }
  }

  const runFull = forceFullRaindrop || previousCache == null;
  const deltaSearch = previousCache ? `lastUpdate:>${previousCache.fetchedAt}` : undefined;

  const [rootResult, childResult, fetchedRaindrops, userData] = await Promise.all([
    raindropApi<{ items: any[] }>("/collections", { etag: previousCache?.collectionsETag }),
    raindropApi<{ items: any[] }>("/collections/childrens", { etag: previousCache?.childrensETag }),
    runFull ? fetchAllRaindrops() : fetchAllRaindrops(deltaSearch),
    raindropApiSimple<{ user: { groups: Array<{ title: string; collections: number[] }> } }>("/user"),
  ]);

  const groups = userData.user.groups;

  const rootNotModified = rootResult.data === null;
  const childNotModified = childResult.data === null;
  let allCollections: any[];
  let collectionsChanged: boolean;
  let newCollectionsETag = rootResult.etag;
  let newChildrensETag = childResult.etag;

  if (rootNotModified && childNotModified) {
    allCollections = previousCache!.collections;
    collectionsChanged = false;
    log("Collections: unchanged (304 Not Modified)");
  } else {
    const rootItems = rootResult.data?.items ?? previousCache?.collections.filter((c: any) => !c.parent?.$id) ?? [];
    const childItems = childResult.data?.items ?? previousCache?.collections.filter((c: any) => c.parent?.$id) ?? [];
    allCollections = [...rootItems, ...childItems];

    const newFingerprint = collectionFingerprint(allCollections);
    if (previousCache?.collectionsFingerprint && newFingerprint === previousCache.collectionsFingerprint) {
      collectionsChanged = false;
      log(`Collections: ${allCollections.length} (fingerprint unchanged)`);
    } else {
      collectionsChanged = true;
      log(`Collections: ${allCollections.length} (changed)`);
    }
  }

  const allRaindrops = runFull
    ? fetchedRaindrops
    : mergeRaindrops(previousCache!.raindrops, fetchedRaindrops);

  log(
    runFull
      ? `Raindrops (full): ${allRaindrops.length}`
      : `Raindrops (delta): +${fetchedRaindrops.length}, total ${allRaindrops.length}`
  );

  const cache: RaindropCache = {
    fetchedAt: new Date().toISOString(),
    collections: allCollections,
    raindrops: allRaindrops,
    groups,
    collectionsETag: newCollectionsETag,
    childrensETag: newChildrensETag,
    collectionsFingerprint: collectionFingerprint(allCollections),
  };

  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  log("Cache written to", cacheFile);

  const collStatus = collectionsChanged ? "changed" : "unchanged";
  if (runFull) {
    console.error(`Raindrop: full sync (${allCollections.length} collections [${collStatus}], ${allRaindrops.length} raindrops)`);
  } else {
    console.error(
      `Raindrop: delta sync (collections: ${collStatus}, raindrops: +${fetchedRaindrops.length} changes, ${allRaindrops.length} total)`
    );
  }
}

async function checkRaindrop(): Promise<boolean> {
  const apiKey = loadConfig();
  raindropHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const cacheFile = join(cacheDir, "raindrop-collections.json");
  if (!existsSync(cacheFile)) return true;

  let previousCache: RaindropCache;
  try {
    previousCache = JSON.parse(readFileSync(cacheFile, "utf-8")) as RaindropCache;
  } catch {
    return true;
  }

  const [rootResult, childResult, deltaResult] = await Promise.all([
    raindropApi<{ items: any[] }>("/collections", { etag: previousCache.collectionsETag }),
    raindropApi<{ items: any[] }>("/collections/childrens", { etag: previousCache.childrensETag }),
    raindropApiSimple<{ items: any[] }>(
      `/raindrops/0?${new URLSearchParams({ perpage: "1", page: "0", search: `lastUpdate:>${previousCache.fetchedAt}` })}`
    ),
  ]);

  let collectionsChanged = false;
  if (rootResult.data !== null || childResult.data !== null) {
    const rootItems = rootResult.data?.items ?? previousCache.collections.filter((c: any) => !c.parent?.$id);
    const childItems = childResult.data?.items ?? previousCache.collections.filter((c: any) => c.parent?.$id);
    const fp = collectionFingerprint([...rootItems, ...childItems]);
    collectionsChanged = fp !== previousCache.collectionsFingerprint;
  }

  const raindropsChanged = deltaResult.items.length > 0;

  log(`Raindrop check: collections ${collectionsChanged ? "changed" : "unchanged"}, raindrops ${raindropsChanged ? "changed" : "unchanged"}`);
  return collectionsChanged || raindropsChanged;
}

if (checkOnly) {
  try {
    const needed = await checkRaindrop();
    console.log(`raindrop: ${needed ? "needs sync" : "up-to-date"}`);
    process.exit(needed ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

try {
  await syncRaindrop();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
