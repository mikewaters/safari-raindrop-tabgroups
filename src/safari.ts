#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- CLI flags ---
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`safari-tabgroups — Extract tab groups from Safari's cached database

Usage: safari-tabgroups [options]

Options:
  --json       Output as JSON instead of plain text
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message

Reads from the cached database at ~/.cache/safari-tabgroups/.
Run sync-tabgroups first to populate or refresh the cache.`);
  process.exit(0);
}

const debug = args.has("--debug");
const verbose = debug || args.has("--verbose");
const jsonMode = args.has("--json");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

// --- Cache path ---
const home = homedir();
const cacheBase = process.env.XDG_CACHE_HOME || join(home, ".cache");
const cacheDir = join(cacheBase, "safari-tabgroups");
const dbPath = join(cacheDir, "SafariTabs.db");

log("Cache path:", dbPath);

if (!existsSync(dbPath)) {
  console.error("No cached data. Run sync-tabgroups first.");
  process.exit(1);
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
}
