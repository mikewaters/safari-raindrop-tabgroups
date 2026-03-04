#!/usr/bin/env bun

/**
 * Syncs cached data for Safari tab groups and/or Raindrop.io collections.
 * This is the only command that writes to the cache — all other commands read from it.
 */

import { Database } from "bun:sqlite";
import { parse } from "smol-toml";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveConfigPath } from "./config.ts";

// --- CLI flags ---
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`sync-tabgroups — Refresh cached data for Safari and/or Raindrop.io

Usage: sync-tabgroups [options]

Options:
  --safari     Only sync Safari tab groups
  --raindrop   Only sync Raindrop.io collections
  --full-raindrop  Force a full Raindrop sync (ignore delta cache)
  --stp        Sync from Safari Technology Preview instead of Safari
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message

Without --safari or --raindrop, syncs both sources.`);
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose") || args.has("--debug");
const useSTP = args.has("--stp");
const forceFullRaindrop = args.has("--full-raindrop");
let wantSafari = args.has("--safari");
let wantRaindrop = args.has("--raindrop");

if (!wantSafari && !wantRaindrop) {
  wantSafari = true;
  wantRaindrop = true;
}

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

const home = homedir();
const cacheBase = process.env.XDG_CACHE_HOME || join(home, ".cache");
const cacheDir = join(cacheBase, "safari-tabgroups");
mkdirSync(cacheDir, { recursive: true });

// --- Safari sync ---

async function syncSafari() {
  const safariBase = useSTP
    ? join(home, "Library/Containers/com.apple.SafariTechnologyPreview/Data/Library/SafariTechnologyPreview")
    : join(home, "Library/Containers/com.apple.Safari/Data/Library/Safari");
  const dbSource = join(safariBase, "SafariTabs.db");
  const dbPath = join(cacheDir, "SafariTabs.db");

  log("Safari source DB:", dbSource);
  log("Safari cache path:", dbPath);

  // Freshness check
  let needsCopy = true;
  if (existsSync(dbPath)) {
    let newestSrcMtime = statSync(dbSource).mtimeMs;
    log(`Source .db mtime:  ${new Date(newestSrcMtime).toISOString()}`);
    for (const suffix of ["-wal", "-shm"]) {
      const src = dbSource + suffix;
      if (existsSync(src)) {
        const mtime = statSync(src).mtimeMs;
        log(`Source ${suffix} mtime: ${new Date(mtime).toISOString()}`);
        if (mtime > newestSrcMtime) newestSrcMtime = mtime;
      }
    }
    let newestCacheMtime = statSync(dbPath).mtimeMs;
    log(`Cache .db mtime:   ${new Date(newestCacheMtime).toISOString()}`);
    for (const suffix of ["-wal", "-shm"]) {
      const cached = dbPath + suffix;
      if (existsSync(cached)) {
        const mtime = statSync(cached).mtimeMs;
        log(`Cache ${suffix} mtime: ${new Date(mtime).toISOString()}`);
        if (mtime > newestCacheMtime) newestCacheMtime = mtime;
      }
    }
    if (newestSrcMtime <= newestCacheMtime) {
      log("Safari cache is fresh, skipping copy");
      needsCopy = false;
    } else {
      log("Safari cache is stale, copying");
    }
  } else {
    log("No cached Safari database found, copying");
  }

  if (needsCopy) {
    copyFileSync(dbSource, dbPath);
    log("Copied database");
    for (const [suffix, label] of [["-wal", "WAL"], ["-shm", "SHM"]] as const) {
      const src = dbSource + suffix;
      if (existsSync(src)) {
        copyFileSync(src, dbPath + suffix);
        log(`Copied ${label}`);
      }
    }
  }

  // Checkpoint WAL so readers get a clean database
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    log("WAL checkpoint completed");
  } finally {
    if (db) db.close();
    // Restore source timestamps so the freshness check works next time
    for (const [src, dst] of [
      [dbSource, dbPath],
      [dbSource + "-wal", dbPath + "-wal"],
      [dbSource + "-shm", dbPath + "-shm"],
    ]) {
      try {
        if (existsSync(src) && existsSync(dst)) {
          const { atime, mtime } = statSync(src);
          utimesSync(dst, atime, mtime);
        }
      } catch { /* best-effort */ }
    }
  }

  console.error(needsCopy ? "Safari: synced" : "Safari: cache is fresh");
}

// --- Raindrop sync ---

const RAINDROP_BASE = "https://api.raindrop.io/rest/v1";
let raindropHeaders: Record<string, string> = {};

async function raindropApi<T>(path: string): Promise<T> {
  const url = `${RAINDROP_BASE}${path}`;
  log("GET", url);
  const res = await fetch(url, { headers: raindropHeaders });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface RaindropCache {
  fetchedAt: string;
  collections: any[];
  raindrops: any[];
  groups?: Array<{ title: string; collections: number[] }>;
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
    const data = await raindropApi<{ items: any[] }>(
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

async function syncRaindrop() {
  // Load config
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

  const [rootData, childData, fetchedRaindrops, userData] = await Promise.all([
    raindropApi<{ items: any[] }>("/collections"),
    raindropApi<{ items: any[] }>("/collections/childrens"),
    runFull ? fetchAllRaindrops() : fetchAllRaindrops(deltaSearch),
    raindropApi<{ user: { groups: Array<{ title: string; collections: number[] }> } }>("/user"),
  ]);

  const groups = userData.user.groups;

  const allCollections = [...rootData.items, ...childData.items];
  const allRaindrops = runFull
    ? fetchedRaindrops
    : mergeRaindrops(previousCache!.raindrops, fetchedRaindrops);

  log(`Collections: ${allCollections.length}`);
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
  };

  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  log("Cache written to", cacheFile);
  if (runFull) {
    console.error(`Raindrop: full sync (${allCollections.length} collections, ${allRaindrops.length} raindrops)`);
  } else {
    console.error(
      `Raindrop: delta sync (+${fetchedRaindrops.length} changes, ${allRaindrops.length} total raindrops)`
    );
  }
}

// --- Main ---

const results = await Promise.allSettled([
  ...(wantSafari ? [syncSafari()] : []),
  ...(wantRaindrop ? [syncRaindrop()] : []),
]);

let failed = false;
for (const r of results) {
  if (r.status === "rejected") {
    console.error(`Error: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    failed = true;
  }
}

if (failed) process.exit(1);
