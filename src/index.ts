#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- CLI flags ---
const args = new Set(process.argv.slice(2));
const useSTP = args.has("--stp");
const debug = args.has("--debug");
const verbose = debug || args.has("--verbose");
const jsonMode = args.has("--json");
const cached = args.has("--cached");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

// --- Paths ---
const home = homedir();
const safariBase = useSTP
  ? join(home, "Library/Containers/com.apple.SafariTechnologyPreview/Data/Library/SafariTechnologyPreview")
  : join(home, "Library/Containers/com.apple.Safari/Data/Library/Safari");
const dbSource = join(safariBase, "SafariTabs.db");

log("Source DB:", dbSource);

// --- Cache location ---
let dbPath: string;
if (debug) {
  dbPath = join(process.cwd(), `SafariTabs-${Date.now()}.db`);
} else {
  const cacheBase = process.env.XDG_CACHE_HOME || join(home, ".cache");
  const cacheDir = join(cacheBase, "safari-tabgroups");
  mkdirSync(cacheDir, { recursive: true });
  dbPath = join(cacheDir, "SafariTabs.db");
}

log("Cache path:", dbPath);

// --- Copy (unless --cached or cache is fresh) ---
if (cached) {
  if (!existsSync(dbPath)) {
    console.error("No cached database found. Run without --cached first.");
    process.exit(1);
  }
  log("Using cached database");
} else {
  let needsCopy = true;
  if (existsSync(dbPath)) {
    // Check the newest mtime across db, wal, and shm — writes hit the WAL
    // before the main db, so we need to check all source files.
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
    // Also check the newest mtime across cached files
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
      log("Cache is fresh (no source files modified since last copy), skipping copy");
      needsCopy = false;
    } else {
      log("Cache is stale (source modified since last copy), copying");
    }
  } else {
    log("No cached database found, copying");
  }

  if (needsCopy) {
    try {
      copyFileSync(dbSource, dbPath);
      log("Copied database");
      for (const [suffix, label] of [["-wal", "WAL"], ["-shm", "SHM"]] as const) {
        const src = dbSource + suffix;
        if (existsSync(src)) {
          copyFileSync(src, dbPath + suffix);
          log(`Copied ${label}`);
        }
      }
    } catch (err) {
      console.error(`Failed to copy SafariTabs.db: ${err}`);
      process.exit(1);
    }
  }
}

// --- Types ---
interface TabGroup {
  name: string;
  tabs: { title: string; url: string }[];
}

interface Profile {
  name: string;
  tabGroups: TabGroup[];
}

// --- Query ---
let db: Database | null = null;
try {
  db = new Database(dbPath);

  // Checkpoint the WAL to merge any pending writes into the main database
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  log("WAL checkpoint completed");

  const profiles: Profile[] = [];

  // Personal profile tab groups
  const personalGroups = db
    .query(
      `SELECT id, title FROM bookmarks
       WHERE type = 1 AND parent = 0 AND subtype = 0 AND num_children > 0 AND hidden = 0
       ORDER BY id DESC`
    )
    .all() as { id: number; title: string }[];

  log(`Personal profile: ${personalGroups.length} tab group(s)`);

  const personalProfile: Profile = {
    name: "Personal",
    tabGroups: [],
  };

  for (const group of personalGroups) {
    const tabs = db
      .query(
        `SELECT title, url FROM bookmarks
         WHERE parent = ? AND url != '' AND title NOT IN ('TopScopedBookmarkList', 'Untitled', 'Start Page')
         ORDER BY order_index ASC`
      )
      .all(group.id) as { title: string; url: string }[];

    if (tabs.length > 0) {
      personalProfile.tabGroups.push({
        name: group.title || "(untitled)",
        tabs,
      });
    }
  }

  profiles.push(personalProfile);

  // Additional profiles
  const additionalProfiles = db
    .query(`SELECT id, title FROM bookmarks WHERE subtype = 2 AND title != ''`)
    .all() as { id: number; title: string }[];

  log(`Additional profiles: ${additionalProfiles.length}`);

  for (const prof of additionalProfiles) {
    const profileEntry: Profile = {
      name: prof.title,
      tabGroups: [],
    };

    const groups = db
      .query(
        `SELECT id, title FROM bookmarks
         WHERE parent = ? AND subtype = 0 AND num_children > 0
         ORDER BY id DESC`
      )
      .all(prof.id) as { id: number; title: string }[];

    log(`Profile "${prof.title}": ${groups.length} tab group(s)`);

    for (const group of groups) {
      const tabs = db
        .query(
          `SELECT title, url FROM bookmarks
           WHERE parent = ? AND url != '' AND title NOT IN ('TopScopedBookmarkList', 'Untitled', 'Start Page')
           ORDER BY order_index ASC`
        )
        .all(group.id) as { title: string; url: string }[];

      if (tabs.length > 0) {
        profileEntry.tabGroups.push({
          name: group.title || "(untitled)",
          tabs,
        });
      }
    }

    profiles.push(profileEntry);
  }

  // --- Output ---
  if (jsonMode) {
    console.log(JSON.stringify({ profiles }, null, 2));
  } else {
    for (const profile of profiles) {
      for (const group of profile.tabGroups) {
        for (const tab of group.tabs) {
          console.log(`${profile.name} / ${group.name} / ${tab.title} (${tab.url})`);
        }
      }
    }
  }
} catch (err) {
  console.error(`Error querying database: ${err}`);
  process.exit(1);
} finally {
  if (db) {
    db.close();
    log("Database closed");
  }
  // Restore source timestamps on cached files so the freshness check works.
  // SQLite modifies the files on open (WAL replay), so we do this after close.
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
  log("Cache retained at", dbPath);
}
