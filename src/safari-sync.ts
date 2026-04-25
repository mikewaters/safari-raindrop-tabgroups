#!/usr/bin/env bun

/**
 * Syncs cached Safari tab group data.
 * Copies the Safari tabs database to a local cache and checkpoints the WAL.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`safari-sync — Refresh cached Safari tab group data

Usage: safari-sync [options]

Options:
  --stp        Sync from Safari Technology Preview instead of Safari
  --check      Check if a sync is needed without performing it
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message`);
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose") || args.has("--debug");
const useSTP = args.has("--stp");
const checkOnly = args.has("--check");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

const home = homedir();
const cacheBase = process.env.XDG_CACHE_HOME || join(home, ".cache");
const cacheDir = join(cacheBase, "safari-tabgroups");
mkdirSync(cacheDir, { recursive: true });

/**
 * Copy a file, falling back to read+write if copyFileSync fails (e.g., cross-filesystem in Docker).
 */
function robustCopy(src: string, dst: string) {
  try {
    copyFileSync(src, dst);
  } catch {
    writeFileSync(dst, readFileSync(src));
  }
}

function getSafariPaths() {
  // Allow override via env var for container environments where the Safari DB
  // is bind-mounted to a known path (e.g., /safari/SafariTabs.db)
  const envSource = process.env.SAFARI_DB_PATH;
  if (envSource) {
    return {
      dbSource: envSource,
      dbPath: join(cacheDir, "SafariTabs.db"),
    };
  }

  const safariBase = useSTP
    ? join(home, "Library/Containers/com.apple.SafariTechnologyPreview/Data/Library/SafariTechnologyPreview")
    : join(home, "Library/Containers/com.apple.Safari/Data/Library/Safari");
  return {
    dbSource: join(safariBase, "SafariTabs.db"),
    dbPath: join(cacheDir, "SafariTabs.db"),
  };
}

function checkSafari(): boolean {
  const { dbSource, dbPath } = getSafariPaths();

  if (!existsSync(dbPath)) return true;

  let newestSrcMtime = statSync(dbSource).mtimeMs;
  for (const suffix of ["-wal", "-shm"]) {
    const src = dbSource + suffix;
    if (existsSync(src)) {
      const mtime = statSync(src).mtimeMs;
      if (mtime > newestSrcMtime) newestSrcMtime = mtime;
    }
  }
  let newestCacheMtime = statSync(dbPath).mtimeMs;
  for (const suffix of ["-wal", "-shm"]) {
    const cached = dbPath + suffix;
    if (existsSync(cached)) {
      const mtime = statSync(cached).mtimeMs;
      if (mtime > newestCacheMtime) newestCacheMtime = mtime;
    }
  }
  return newestSrcMtime > newestCacheMtime;
}

async function syncSafari() {
  const { dbSource, dbPath } = getSafariPaths();

  log("Safari source DB:", dbSource);
  log("Safari cache path:", dbPath);

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
    robustCopy(dbSource, dbPath);
    log("Copied database");
    for (const [suffix, label] of [["-wal", "WAL"], ["-shm", "SHM"]] as const) {
      const src = dbSource + suffix;
      if (existsSync(src)) {
        robustCopy(src, dbPath + suffix);
        log(`Copied ${label}`);
      }
    }
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    log("WAL checkpoint completed");
  } finally {
    if (db) db.close();
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

if (checkOnly) {
  const needed = checkSafari();
  console.log(`safari: ${needed ? "needs sync" : "up-to-date"}`);
  process.exit(needed ? 0 : 1);
}

try {
  await syncSafari();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
