#!/usr/bin/env bun

/**
 * bookmark-index — Unified index of Safari tab groups and Raindrop collections.
 *
 * Maintains a local SQLite database (bookmarks.db) that stores tab groups,
 * collections, their child tabs/bookmarks, and LLM-generated classifications.
 * Supports matching new URLs against stored classifications.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { fetchAndConvertToMarkdown } from "scrape2md";
import { getTabLastActive, getDateAdded } from "./plist.ts";
import { resolveConfigPath } from "./config.ts";
import { getStrategy } from "./match/types";
import { extractPageSignals, scoreGroupCandidates, type PageSignals } from "./match/llm-fetch";

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

const HELP = `bookmark-index — Unified index of Safari tab groups and Raindrop collections

Usage: bookmark-index <command> [options]

Commands:
  update     Sync index from cached Safari/Raindrop data
  list       List indexed collections with Collection Card status
  list unclassified  List collections without a Collection Card
  show       Show full detail for a collection
  classify   Generate a Collection Card using LLM or import from stdin
  match      Find matching collections for a URL
  version    List, set, or copy Collection Card versions for a collection
  backup     Checkpoint WAL and create a rotating backup of the database
  stats      Show database path, collection counts, and cache freshness

Run bookmark-index <command> --help for command-specific options.`;

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

// Parse flags after the command
const flags = new Set<string>();
const positional: string[] = [];
const flagValues: Record<string, string> = {};

for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--top" || arg === "--db" || arg === "--expected" || arg === "--type" || arg === "--notes" || arg === "--author" || arg === "--strategy" || arg === "--limit" || arg === "--offset") {
    flagValues[arg] = argv[++i];
  } else if (arg.startsWith("--")) {
    flags.add(arg);
  } else if (arg.startsWith("-")) {
    flags.add(arg);
  } else {
    positional.push(arg);
  }
}

const verbose = flags.has("--verbose") || flags.has("--debug");
const jsonMode = flags.has("--json");

function log(...msg: unknown[]) {
  if (verbose) console.error("[index]", ...msg);
}

// ─── Database Setup ──────────────────────────────────────────────────────────

function resolveDbPath(): string {
  if (flagValues["--db"]) return flagValues["--db"];

  const configPath = resolveConfigPath();
  log("config:", configPath);
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as any;
  let dbPath: string = parsed.database?.path || "$XDG_DATA_HOME/safari-tabgroups/bookmarks.db";

  // Resolve $ENV_VAR references
  dbPath = dbPath.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => {
    if (name === "XDG_DATA_HOME") {
      return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    }
    return process.env[name] || "";
  });

  // Resolve ~ at start of path
  if (dbPath.startsWith("~")) {
    dbPath = join(homedir(), dbPath.slice(1));
  }

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  return dbPath;
}

const DB_PATH = resolveDbPath();
log("database:", DB_PATH);

function openDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL CHECK(source IN ('safari', 'raindrop')),
      source_id     TEXT NOT NULL,
      name          TEXT NOT NULL,
      profile       TEXT,
      tab_count     INTEGER NOT NULL DEFAULT 0,
      last_active   TEXT,
      created_at    TEXT,
      description   TEXT,
      category      TEXT,
      topics        TEXT,
      intent        TEXT,
      confidence    REAL,
      classified_at TEXT,
      updated_at    TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
    CREATE TABLE IF NOT EXISTS items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      last_active   TEXT,
      created_at    TEXT,
      UNIQUE(group_id, url)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS match_cache (
      url       TEXT PRIMARY KEY,
      result    TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS match_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      url              TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      page_category    TEXT,
      page_topics      TEXT,
      page_description TEXT,
      candidate_count  INTEGER,
      candidates_sent  INTEGER,
      candidate_ids    TEXT,
      prescore_cutoff  REAL,
      model            TEXT,
      raw_response     TEXT,
      match_results    TEXT,
      top_match_group  TEXT,
      top_match_score  REAL
    );
    CREATE TABLE IF NOT EXISTS match_feedback (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      match_log_id    INTEGER REFERENCES match_log(id),
      url             TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      expected_group  TEXT,
      expected_source TEXT,
      feedback_type   TEXT NOT NULL CHECK(feedback_type IN ('wrong_match','missing_match','correct','note')),
      notes           TEXT
    );
    CREATE TABLE IF NOT EXISTS group_classifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      description TEXT,
      category    TEXT,
      topics      TEXT,
      intent      TEXT,
      confidence  REAL,
      author      TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE(group_id, version)
    );
  `);

  // Add active_version column to groups (idempotent — ignores if already exists)
  try { db.exec("ALTER TABLE groups ADD COLUMN active_version INTEGER REFERENCES group_classifications(id)"); } catch {}

  // One-time migration: seed group_classifications from inline classification data
  const unmigratedGroups = db.prepare(
    `SELECT id, description, category, topics, intent, confidence, classified_at
     FROM groups WHERE classified_at IS NOT NULL AND active_version IS NULL`
  ).all() as any[];

  for (const g of unmigratedGroups) {
    const info = db.prepare(
      `INSERT INTO group_classifications (group_id, version, description, category, topics, intent, confidence, author, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'migrated', ?)`
    ).run(g.id, g.description, g.category, g.topics, g.intent, g.confidence, g.classified_at);
    db.prepare(`UPDATE groups SET active_version = ? WHERE id = ?`).run(info.lastInsertRowid, g.id);
  }
  if (unmigratedGroups.length > 0) {
    log(`Migrated ${unmigratedGroups.length} inline classification(s) to group_classifications`);
  }

  return db;
}

/**
 * Look up a group by name, preferring Safari over Raindrop when duplicates exist.
 * Returns null if no match found.
 */
function resolveGroup(db: Database, name: string, columns = "*"): any {
  return db
    .prepare(
      `SELECT ${columns} FROM groups WHERE name = ?
       ORDER BY CASE WHEN source = 'safari' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(name) ?? null;
}

// ─── Shared Types ────────────────────────────────────────────────────────────

interface Tab {
  title: string;
  url: string;
}
interface TabGroup {
  id: number;
  name: string;
  tabs: Tab[];
}
interface Profile {
  name: string;
  tabGroups: TabGroup[];
}
interface RaindropCache {
  fetchedAt: string;
  collections: any[];
  raindrops: any[];
}

// ─── Config Loading ──────────────────────────────────────────────────────────

interface MatchConfig {
  system_prompt: string;
  max_groups_in_prompt: number;
  max_page_bytes: number;
  cache_ttl_minutes: number;
}

interface OpenRouterConfig {
  api_key: string;
  model: string;
  system_prompt: string;
  max_content_bytes: number;
  max_tokens?: number;
}

interface DescribeConfig {
  categories: string[];
  system_prompt: string;
}

function loadConfig(): {
  openrouter: OpenRouterConfig;
  match: MatchConfig;
  describe: DescribeConfig;
} {
  const configPath = resolveConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as any;
  return {
    openrouter: parsed.openrouter,
    match: {
      system_prompt: DEFAULT_MATCH_PROMPT,
      max_groups_in_prompt: 30,
      max_page_bytes: 20000,
      cache_ttl_minutes: 30,
      ...parsed.match,
    },
    describe: parsed.describe,
  };
}

function resolveApiKey(config: OpenRouterConfig): string {
  let key = config.api_key;
  if (key.startsWith("$")) {
    key = process.env[key.slice(1)] || "";
  }
  if (!key) {
    console.error(
      "OpenRouter API key not set. Configure in fetch.config.toml or set the env var."
    );
    process.exit(1);
  }
  return key;
}

const DEFAULT_MATCH_PROMPT = `You are a research librarian. A user has found a web page and wants to know which of their existing bookmark groups it best fits into.

Given the web page content and a list of bookmark groups with their descriptions, classify this page using the same schema as the groups, then determine which groups are the best match.

Respond with ONLY a JSON object (no markdown fences):
{
  "classification": {
    "category": "<one of the standard categories>",
    "topics": ["topic1", "topic2"],
    "description": "1-2 sentence description of the page"
  },
  "matches": [
    {"group": "<exact group name>", "source": "safari|raindrop", "score": 0.0-1.0, "reason": "why this matches"}
  ]
}

Order matches by score descending. Include only groups scoring above 0.3.`;

// ─── UPDATE Command ──────────────────────────────────────────────────────────

async function cmdUpdate() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index update — Sync index from cached data

Usage: bookmark-index update [--safari] [--raindrop] [--verbose]

Updates the local bookmarks.db from the sync cache at ~/.cache/safari-tabgroups/.
Adds new collections, updates existing ones, and removes collections deleted from source.`);
    process.exit(0);
  }

  const wantSafari = flags.has("--safari") || !flags.has("--raindrop");
  const wantRaindrop = flags.has("--raindrop") || !flags.has("--safari");

  const db = openDb();
  const now = new Date().toISOString();
  let added = 0,
    updated = 0,
    removed = 0;

  try {
    if (wantSafari) {
      const result = await updateSafari(db, now);
      added += result.added;
      updated += result.updated;
      removed += result.removed;
    }
    if (wantRaindrop) {
      const result = updateRaindrop(db, now);
      added += result.added;
      updated += result.updated;
      removed += result.removed;
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('last_indexed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(now);
  } finally {
    db.close();
  }

  console.error(`Updated index: +${added} added, ~${updated} updated, -${removed} removed`);
}

async function updateSafari(
  db: Database,
  now: string
): Promise<{ added: number; updated: number; removed: number }> {
  // Get tab groups via safari.ts subprocess
  log("Spawning safari.ts --json...");
  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "safari.ts"), "--json"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`safari.ts failed: ${stderr}`);
    return { added: 0, updated: 0, removed: 0 };
  }

  const data = JSON.parse(stdout) as { profiles: Profile[] };

  // Open cached Safari DB directly for plist blob access
  const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const safariDbPath = join(cacheBase, "safari-tabgroups", "SafariTabs.db");
  if (!existsSync(safariDbPath)) {
    console.error("No cached Safari database. Run sync-tabgroups first.");
    return { added: 0, updated: 0, removed: 0 };
  }
  const safariDb = new Database(safariDbPath, { readonly: true });

  const insertGroup = db.prepare(`
    INSERT INTO groups (source, source_id, name, profile, tab_count, last_active, created_at, updated_at)
    VALUES ('safari', ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateGroup = db.prepare(`
    UPDATE groups SET name = ?, profile = ?, tab_count = ?, last_active = ?,
      created_at = COALESCE(?, created_at), updated_at = ?
    WHERE id = ?
  `);

  const upsertItem = db.prepare(`
    INSERT INTO items (group_id, title, url, last_active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, url) DO UPDATE SET
      title = excluded.title,
      last_active = excluded.last_active,
      created_at = COALESCE(excluded.created_at, items.created_at)
  `);

  const getExistingGroup = db.prepare(
    `SELECT id, name, profile, tab_count, last_active FROM groups WHERE source = 'safari' AND source_id = ?`
  );

  const getExistingItems = db.prepare(
    `SELECT title, url, last_active FROM items WHERE group_id = ? ORDER BY url`
  );

  const deleteItemsForGroup = db.prepare(
    `DELETE FROM items WHERE group_id = ?`
  );

  const seenSourceIds = new Set<string>();
  let added = 0,
    updated = 0;

  for (const profile of data.profiles) {
    for (const group of profile.tabGroups) {
      const sourceId = String(group.id);
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);

      // Get plist blobs for child tabs to compute last_active
      const childRows = safariDb
        .query(
          `SELECT id, title, url, extra_attributes, local_attributes
           FROM bookmarks
           WHERE parent = ? AND url != '' AND url IS NOT NULL`
        )
        .all(group.id) as {
        id: number;
        title: string;
        url: string;
        extra_attributes: Buffer | null;
        local_attributes: Buffer | null;
      }[];

      // Get group's own creation date
      const groupRow = safariDb
        .query(`SELECT extra_attributes FROM bookmarks WHERE id = ?`)
        .get(group.id) as { extra_attributes: Buffer | null } | null;

      const groupCreatedAt = groupRow
        ? await getDateAdded(groupRow.extra_attributes)
        : null;

      // Compute per-tab timestamps and group last_active
      const tabTimestamps: {
        title: string;
        url: string;
        lastActive: string | null;
        createdAt: string | null;
      }[] = [];

      let groupLastActive: string | null = null;

      for (const row of childRows) {
        const lastActive = await getTabLastActive(
          row.extra_attributes,
          row.local_attributes
        );
        const createdAt = row.extra_attributes
          ? await getDateAdded(row.extra_attributes)
          : null;

        tabTimestamps.push({
          title: row.title,
          url: row.url,
          lastActive,
          createdAt,
        });

        if (lastActive && (!groupLastActive || lastActive > groupLastActive)) {
          groupLastActive = lastActive;
        }
      }

      // Deduplicate tabs by URL (last wins, matching ON CONFLICT behavior)
      const tabsByUrl = new Map<string, typeof tabTimestamps[0]>();
      for (const t of tabTimestamps) {
        tabsByUrl.set(t.url, t);
      }
      const dedupedTabs = [...tabsByUrl.values()];
      const newItems = dedupedTabs
        .map(t => ({ title: t.title, url: t.url, last_active: t.lastActive }))
        .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

      // Check if this is an insert or update
      const existing = getExistingGroup.get(sourceId) as {
        id: number; name: string; profile: string | null;
        tab_count: number; last_active: string | null;
      } | null;

      if (!existing) {
        insertGroup.run(sourceId, group.name, profile.name, dedupedTabs.length, groupLastActive, groupCreatedAt, now);
        const newRow = getExistingGroup.get(sourceId) as { id: number };
        for (const tab of dedupedTabs) {
          upsertItem.run(newRow.id, tab.title, tab.url, tab.lastActive, tab.createdAt);
        }
        added++;
        continue;
      }

      const groupId = existing.id;

      // Detect group-level changes
      const groupChanged =
        existing.name !== group.name ||
        existing.profile !== profile.name ||
        existing.tab_count !== dedupedTabs.length ||
        existing.last_active !== groupLastActive;

      // Detect item-level changes
      const oldItems = getExistingItems.all(groupId) as { title: string; url: string; last_active: string | null }[];

      let itemsChanged = oldItems.length !== newItems.length;
      if (!itemsChanged) {
        for (let i = 0; i < oldItems.length; i++) {
          if (oldItems[i].url !== newItems[i].url ||
              oldItems[i].title !== newItems[i].title ||
              oldItems[i].last_active !== newItems[i].last_active) {
            itemsChanged = true;
            break;
          }
        }
      }

      if (groupChanged || itemsChanged) {
        updateGroup.run(group.name, profile.name, dedupedTabs.length, groupLastActive, groupCreatedAt, now, groupId);
        deleteItemsForGroup.run(groupId);
        for (const tab of dedupedTabs) {
          upsertItem.run(groupId, tab.title, tab.url, tab.lastActive, tab.createdAt);
        }
        updated++;
      }
    }
  }

  safariDb.close();

  // Remove stale groups
  const existingGroups = db
    .prepare(`SELECT id, source_id FROM groups WHERE source = 'safari'`)
    .all() as { id: number; source_id: string }[];

  let removed = 0;
  for (const g of existingGroups) {
    if (!seenSourceIds.has(g.source_id)) {
      db.prepare(`DELETE FROM groups WHERE id = ?`).run(g.id);
      removed++;
    }
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_sync_safari', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(now);

  log(`Safari: +${added}, ~${updated}, -${removed}`);
  return { added, updated, removed };
}

function updateRaindrop(
  db: Database,
  now: string
): { added: number; updated: number; removed: number } {
  const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const cacheFile = join(cacheBase, "safari-tabgroups", "raindrop-collections.json");

  if (!existsSync(cacheFile)) {
    console.error("No cached Raindrop data. Run sync-tabgroups --raindrop first.");
    return { added: 0, updated: 0, removed: 0 };
  }

  const cache: RaindropCache = JSON.parse(readFileSync(cacheFile, "utf-8"));
  log(`Loaded Raindrop cache from ${cache.fetchedAt}`);

  // Build parent title lookup for nested collections
  const titleById = new Map<number, string>();
  for (const c of cache.collections) titleById.set(c._id, c.title);

  function fullTitle(col: any): string {
    if (col.parent?.$id) {
      const parentTitle = titleById.get(col.parent.$id);
      if (parentTitle) return `${parentTitle} / ${col.title}`;
    }
    return col.title;
  }

  // Group raindrops by collection
  const raindropsByCollection = new Map<number, any[]>();
  for (const r of cache.raindrops) {
    const colId = r.collection?.$id;
    if (colId == null) continue;
    let list = raindropsByCollection.get(colId);
    if (!list) {
      list = [];
      raindropsByCollection.set(colId, list);
    }
    list.push(r);
  }

  const insertGroup = db.prepare(`
    INSERT INTO groups (source, source_id, name, tab_count, last_active, created_at, updated_at)
    VALUES ('raindrop', ?, ?, ?, ?, ?, ?)
  `);

  const updateGroup = db.prepare(`
    UPDATE groups SET name = ?, tab_count = ?, last_active = ?,
      created_at = COALESCE(?, created_at), updated_at = ?
    WHERE id = ?
  `);

  const insertItem = db.prepare(`
    INSERT INTO items (group_id, title, url, last_active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, url) DO UPDATE SET
      title = excluded.title,
      last_active = excluded.last_active
  `);

  const getExistingGroup = db.prepare(
    `SELECT id, name, tab_count, last_active FROM groups WHERE source = 'raindrop' AND source_id = ?`
  );

  const getExistingItems = db.prepare(
    `SELECT title, url, last_active FROM items WHERE group_id = ? ORDER BY url`
  );

  const deleteItemsForGroup = db.prepare(
    `DELETE FROM items WHERE group_id = ?`
  );

  const seenSourceIds = new Set<string>();
  let added = 0,
    updated = 0;

  for (const col of cache.collections) {
    const colRaindrops = raindropsByCollection.get(col._id) || [];
    if (colRaindrops.length === 0) continue;

    const sourceId = String(col._id);
    if (seenSourceIds.has(sourceId)) continue;
    seenSourceIds.add(sourceId);

    const name = fullTitle(col);
    const lastActive = col.lastUpdate || null;
    const createdAt = col.created || null;

    // Deduplicate by URL (last wins, matching ON CONFLICT behavior)
    const itemsByUrl = new Map<string, { title: string; url: string; last_active: string | null; createdAt: string | null }>();
    for (const r of colRaindrops) {
      if (!r.link) continue;
      itemsByUrl.set(r.link, {
        title: r.title || "(untitled)",
        url: r.link,
        last_active: r.lastUpdate || null,
        createdAt: r.created || null,
      });
    }
    const newItems = [...itemsByUrl.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const tabCount = newItems.length;

    const existing = getExistingGroup.get(sourceId) as {
      id: number; name: string; tab_count: number; last_active: string | null;
    } | null;

    if (!existing) {
      insertGroup.run(sourceId, name, tabCount, lastActive, createdAt, now);
      const newRow = getExistingGroup.get(sourceId) as { id: number };
      for (const item of newItems) {
        insertItem.run(newRow.id, item.title, item.url, item.last_active, item.createdAt);
      }
      added++;
      continue;
    }

    const groupId = existing.id;

    // Detect group-level changes
    const groupChanged =
      existing.name !== name ||
      existing.tab_count !== tabCount ||
      existing.last_active !== lastActive;

    // Detect item-level changes
    const oldItems = getExistingItems.all(groupId) as { title: string; url: string; last_active: string | null }[];

    let itemsChanged = oldItems.length !== newItems.length;
    if (!itemsChanged) {
      for (let i = 0; i < oldItems.length; i++) {
        if (oldItems[i].url !== newItems[i].url ||
            oldItems[i].title !== newItems[i].title ||
            oldItems[i].last_active !== newItems[i].last_active) {
          itemsChanged = true;
          break;
        }
      }
    }

    if (groupChanged || itemsChanged) {
      updateGroup.run(name, tabCount, lastActive, createdAt, now, groupId);
      deleteItemsForGroup.run(groupId);
      for (const item of newItems) {
        insertItem.run(groupId, item.title, item.url, item.last_active, item.createdAt);
      }
      updated++;
    }
  }

  // Remove stale groups
  const existingGroups = db
    .prepare(`SELECT id, source_id FROM groups WHERE source = 'raindrop'`)
    .all() as { id: number; source_id: string }[];

  let removed = 0;
  for (const g of existingGroups) {
    if (!seenSourceIds.has(g.source_id)) {
      db.prepare(`DELETE FROM groups WHERE id = ?`).run(g.id);
      removed++;
    }
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_sync_raindrop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(now);

  log(`Raindrop: +${added}, ~${updated}, -${removed}`);
  return { added, updated, removed };
}

// ─── LIST Command ────────────────────────────────────────────────────────────

function cmdList() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index list — List indexed collections

Usage: bookmark-index list [unclassified] [--json] [--safari] [--raindrop] [--limit N] [--offset N]

Subcommands:
  (none)          List all collections with Collection Card status
  unclassified    List only collections without a Collection Card

Options:
  --safari        Show only Safari collections
  --raindrop      Show only Raindrop collections
  --limit N       Return at most N results
  --offset N      Skip the first N results (use with --limit for paging)
  --json          Output as JSON (includes total count for paging)`);
    process.exit(0);
  }

  const subcommand = positional[0];
  const unclassifiedOnly = subcommand === "unclassified";

  const db = openDb();
  try {
    let sql = `SELECT g.id, g.source, g.name, g.profile, g.tab_count, g.last_active,
                      COALESCE(c.category, g.category) as category,
                      g.classified_at, g.active_version
               FROM groups g
               LEFT JOIN group_classifications c ON g.active_version = c.id`;
    const conditions: string[] = [];
    if (flags.has("--safari") && !flags.has("--raindrop"))
      conditions.push(`g.source = 'safari'`);
    if (flags.has("--raindrop") && !flags.has("--safari"))
      conditions.push(`g.source = 'raindrop'`);
    if (unclassifiedOnly)
      conditions.push(`g.active_version IS NULL`);
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;

    // Get total before paging
    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const total = (db.prepare(countSql).get() as { total: number }).total;

    sql += ` ORDER BY g.last_active DESC NULLS LAST`;

    const limit = flagValues["--limit"] ? parseInt(flagValues["--limit"], 10) : null;
    const offset = flagValues["--offset"] ? parseInt(flagValues["--offset"], 10) : 0;
    if (limit != null) sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const rows = db.prepare(sql).all() as any[];

    if (jsonMode) {
      console.log(JSON.stringify({ total, offset, limit, rows }, null, 2));
    } else {
      if (rows.length === 0) {
        if (unclassifiedOnly) {
          console.log("All collections have Collection Cards.");
        } else {
          console.log("No collections indexed. Run: bookmark-index update");
        }
        return;
      }
      for (const r of rows) {
        const classified = r.active_version ? r.category || "yes" : "-";
        const active = r.last_active
          ? new Date(r.last_active).toLocaleDateString()
          : "unknown";
        const profile = r.profile ? ` (${r.profile})` : "";
        console.log(
          `[${r.source}] ${r.name}${profile}  |  ${r.tab_count} tabs  |  active: ${active}  |  classified: ${classified}`
        );
      }
      if (limit != null) {
        const showing = offset + rows.length;
        console.error(`\nShowing ${offset + 1}–${showing} of ${total}`);
      }
    }
  } finally {
    db.close();
  }
}

// ─── SHOW Command ────────────────────────────────────────────────────────────

function cmdShow() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index show — Show full collection detail

Usage: bookmark-index show <group-name> [--json] [--verbose]

Shows a collection's Collection Card, tabs, and metadata.`);
    process.exit(0);
  }

  const name = positional[0];
  if (!name) {
    console.error("Usage: bookmark-index show <group-name>");
    process.exit(1);
  }

  const db = openDb();
  try {
    const group = resolveGroup(db, name);

    if (!group) {
      // Try partial match
      const matches = db
        .prepare(`SELECT name, source FROM groups WHERE name LIKE ?`)
        .all(`%${name}%`) as any[];
      if (matches.length > 0) {
        console.error(`Group "${name}" not found. Did you mean:`);
        for (const m of matches) console.error(`  [${m.source}] ${m.name}`);
      } else {
        console.error(`Group "${name}" not found.`);
      }
      process.exit(1);
    }

    const items = db
      .prepare(
        `SELECT title, url, last_active, created_at FROM items WHERE group_id = ? ORDER BY last_active DESC NULLS LAST`
      )
      .all(group.id) as any[];

    // Load active classification version info
    let activeClassification: any = null;
    let versionInfo = "";
    if (group.active_version) {
      activeClassification = db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM group_classifications WHERE group_id = c.group_id) as total_versions
         FROM group_classifications c WHERE c.id = ?`
      ).get(group.active_version);
      if (activeClassification) {
        versionInfo = ` (v${activeClassification.version} of ${activeClassification.total_versions})`;
      }
    }

    if (jsonMode) {
      const cls = activeClassification || group;
      console.log(
        JSON.stringify(
          {
            ...group,
            topics: cls.topics ? JSON.parse(cls.topics) : null,
            description: cls.description,
            category: cls.category,
            intent: cls.intent,
            confidence: cls.confidence,
            version: activeClassification?.version ?? null,
            total_versions: activeClassification?.total_versions ?? 0,
            author: activeClassification?.author ?? null,
            items,
          },
          null,
          2
        )
      );
    } else {
      console.log(`[${group.source}] ${group.name}`);
      if (group.profile) console.log(`Profile: ${group.profile}`);
      console.log(`Tabs: ${group.tab_count}`);
      if (group.last_active)
        console.log(`Last active: ${group.last_active}`);
      if (group.created_at) console.log(`Created: ${group.created_at}`);
      if (activeClassification) {
        console.log(`\nClassification${versionInfo} (${activeClassification.created_at}):`);
        console.log(`  Category: ${activeClassification.category}`);
        console.log(`  Topics: ${activeClassification.topics}`);
        console.log(`  Description: ${activeClassification.description}`);
        console.log(`  Intent: ${activeClassification.intent}`);
        console.log(`  Confidence: ${activeClassification.confidence}`);
        console.log(`  Author: ${activeClassification.author}`);
      } else if (group.description) {
        console.log(`\nClassification (${group.classified_at}):`);
        console.log(`  Category: ${group.category}`);
        console.log(`  Topics: ${group.topics}`);
        console.log(`  Description: ${group.description}`);
        console.log(`  Intent: ${group.intent}`);
        console.log(`  Confidence: ${group.confidence}`);
      }
      console.log(`\nTabs:`);
      for (const item of items) {
        const active = item.last_active
          ? ` (${new Date(item.last_active).toLocaleDateString()})`
          : "";
        console.log(`  ${item.title}${active}`);
        console.log(`    ${item.url}`);
      }
    }
  } finally {
    db.close();
  }
}

// ─── CLASSIFY Command ────────────────────────────────────────────────────────

async function cmdClassify() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index classify — Generate Collection Cards

Usage: bookmark-index classify <group-name> [--fetch] [--force] [--verbose]
       bookmark-index classify --all [--unclassified] [--force] [--fetch] [--verbose]
       bookmark-index classify --import <group-name> [--author <name>]
       bookmark-index classify --import --all [--author <name>]

Generates a Collection Card by delegating to describe-tabgroup.
Cards are stored as versioned classifications in the index database.
--force re-generates even if a card already exists.
--unclassified only generates cards for collections without one.
--import reads a Collection Card JSON from stdin instead of calling the LLM.
--author sets the card author (default: "import").
  Single: echo '{"description":"...","category":"research",...}' | bookmark-index classify --import "Name"
  Batch:  echo '{"Group A": {...}, ...}' | bookmark-index classify --import --all`);
    process.exit(0);
  }

  const db = openDb();

  if (flags.has("--import")) {
    return cmdClassifyImport(db);
  }

  const all = flags.has("--all");
  const force = flags.has("--force");
  const unclassifiedOnly = flags.has("--unclassified");
  const fetchFlag = flags.has("--fetch");
  const name = positional[0];

  if (!name && !all) {
    console.error("Usage: bookmark-index classify <group-name> or --all");
    process.exit(1);
  }
  try {
    let groups: { id: number; name: string; source: string; classified_at: string | null }[];

    if (all) {
      let sql = `SELECT id, name, source, classified_at FROM groups`;
      if (unclassifiedOnly) sql += ` WHERE classified_at IS NULL`;
      sql += ` ORDER BY id`;
      groups = db.prepare(sql).all() as any[];
    } else {
      const group = resolveGroup(db, name!, "id, name, source, classified_at");
      if (!group) {
        console.error(`Group "${name}" not found in index.`);
        process.exit(1);
      }
      groups = [group];
    }

    let classified = 0;
    for (const group of groups) {
      if (group.classified_at && !force) {
        log(`Skipping "${group.name}" (already classified)`);
        continue;
      }

      console.error(`Classifying: ${group.name}...`);

      // Determine source flag for describe
      const sourceFlag = group.source === "safari" ? "--safari" : "--raindrop";
      const describeArgs = [
        "bun", "run", join(import.meta.dir, "describe.ts"),
        group.name, sourceFlag,
      ];
      if (fetchFlag) describeArgs.push("--fetch");

      const proc = Bun.spawn(describeArgs, {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        console.error(`  Failed to classify "${group.name}": ${stderr}`);
        continue;
      }

      try {
        const result = JSON.parse(stdout.trim());
        const config = loadConfig();
        storeClassification(db, group.id, result, `openrouter/${config.openrouter.model}`);

        classified++;
        console.error(`  ${group.name} → ${result.category} [${(result.topics || []).join(", ")}]`);
      } catch (err) {
        console.error(`  Failed to parse describe output for "${group.name}": ${err}`);
        log(`  Raw output: ${stdout}`);
      }
    }

    console.error(`Classified ${classified} group(s).`);
  } finally {
    db.close();
  }
}

// ─── CLASSIFY --import ───────────────────────────────────────────────────────

const REQUIRED_CLASSIFICATION_FIELDS = ["description", "category", "topics", "intent", "confidence"] as const;

function loadValidCategories(): Set<string> {
  const config = loadConfig();
  return new Set(config.describe.categories);
}

function validateClassification(
  obj: any,
  validCategories: Set<string>
): string[] {
  const warnings: string[] = [];

  for (const field of REQUIRED_CLASSIFICATION_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      warnings.push(`missing required field "${field}"`);
    }
  }
  if (warnings.length > 0) return warnings;

  if (typeof obj.description !== "string")
    warnings.push(`"description" must be a string`);
  if (typeof obj.category !== "string")
    warnings.push(`"category" must be a string`);
  else if (!validCategories.has(obj.category))
    warnings.push(
      `"category" "${obj.category}" is not in the configured list: ${[...validCategories].join(", ")}`
    );
  if (!Array.isArray(obj.topics))
    warnings.push(`"topics" must be an array`);
  if (typeof obj.intent !== "string")
    warnings.push(`"intent" must be a string`);
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1)
    warnings.push(`"confidence" must be a number between 0 and 1`);

  return warnings;
}

function storeClassification(
  db: Database,
  groupId: number,
  result: any,
  author: string = "unknown"
): void {
  const now = new Date().toISOString();
  const topicsJson = result.topics ? JSON.stringify(result.topics) : null;

  // Determine next version number
  const row = db.prepare(
    `SELECT COALESCE(MAX(version), 0) as max_ver FROM group_classifications WHERE group_id = ?`
  ).get(groupId) as { max_ver: number };
  const nextVersion = row.max_ver + 1;

  // Insert versioned classification
  const info = db.prepare(`
    INSERT INTO group_classifications (group_id, version, description, category, topics, intent, confidence, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    nextVersion,
    result.description || null,
    result.category || null,
    topicsJson,
    result.intent || null,
    result.confidence ?? null,
    author,
    now
  );

  // Update groups: set active_version and inline fields for backward compat
  db.prepare(`
    UPDATE groups SET
      active_version = ?,
      description = ?,
      category = ?,
      topics = ?,
      intent = ?,
      confidence = ?,
      classified_at = ?
    WHERE id = ?
  `).run(
    info.lastInsertRowid,
    result.description || null,
    result.category || null,
    topicsJson,
    result.intent || null,
    result.confidence ?? null,
    now,
    groupId
  );
}

async function cmdClassifyImport(db: Database): Promise<void> {
  const all = flags.has("--all");
  const name = positional[0];
  const author = flagValues["--author"] || "import";

  if (!name && !all) {
    console.error("Usage: bookmark-index classify --import <group-name>");
    console.error("       bookmark-index classify --import --all");
    process.exit(1);
  }

  // Read JSON from stdin
  const stdinText = await new Response(Bun.stdin.stream()).text();
  let input: any;
  try {
    input = JSON.parse(stdinText.trim());
  } catch (err) {
    console.error(`Failed to parse JSON from stdin: ${err}`);
    process.exit(1);
  }

  const validCategories = loadValidCategories();
  let imported = 0;
  let skipped = 0;

  try {
    if (all) {
      // Batch mode: input is { "Group Name": { ...classification }, ... }
      if (typeof input !== "object" || Array.isArray(input)) {
        console.error("Batch import expects a JSON object keyed by group name.");
        process.exit(1);
      }

      for (const [groupName, classification] of Object.entries(input)) {
        const matchingGroups = db
          .prepare(`SELECT id, name, source FROM groups WHERE name = ?`)
          .all(groupName) as { id: number; name: string; source: string }[];

        if (matchingGroups.length === 0) {
          console.error(`  Warning: group "${groupName}" not found in index, skipping.`);
          skipped++;
          continue;
        }

        const warnings = validateClassification(classification, validCategories);
        if (warnings.length > 0) {
          console.error(`  Warning: skipping "${groupName}": ${warnings.join("; ")}`);
          skipped++;
          continue;
        }

        for (const group of matchingGroups) {
          storeClassification(db, group.id, classification, author);
          imported++;
          console.error(`  [${group.source}] ${groupName} → ${(classification as any).category} [${((classification as any).topics || []).join(", ")}]`);
        }
      }
    } else {
      // Single mode: input is { ...classification }
      const group = resolveGroup(db, name!, "id, name, source");

      if (!group) {
        console.error(`Group "${name}" not found in index.`);
        process.exit(1);
      }

      const warnings = validateClassification(input, validCategories);
      if (warnings.length > 0) {
        console.error(`Invalid classification: ${warnings.join("; ")}`);
        process.exit(1);
      }

      storeClassification(db, group.id, input, author);
      imported++;
      console.error(`  ${group.name} → ${input.category} [${(input.topics || []).join(", ")}]`);
    }

    console.error(`Imported ${imported} classification(s)${skipped > 0 ? `, skipped ${skipped}` : ""}.`);
  } finally {
    db.close();
  }
}

// ─── MATCH Command ───────────────────────────────────────────────────────────

async function cmdMatch() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index match — Find matching collections for a URL

Usage: bookmark-index match <url> [hint] [--json] [--top N] [--no-prescore] [--no-cache] [--strategy NAME] [--verbose]
       bookmark-index match --feedback <url> --expected <group> [--type wrong_match|missing_match|correct|note] [--notes "..."]
       bookmark-index match --audit [--json] [--has-feedback] [--wrong-only]
       bookmark-index match --diagnose <url> [--json]

Fetches the URL, classifies it with an LLM, then matches against
stored Collection Cards. Collections are pre-scored locally for
100% coverage, then the top candidates are sent to the LLM.

An optional hint (e.g. "sandbox") skips the cache and boosts groups
whose name, description, or topics match the hint term. This helps
bridge semantic gaps that keyword matching alone cannot handle.

Options:
  --no-prescore   Skip local pre-scoring (use arbitrary group order)
  --no-cache      Skip the match cache and force a fresh match
  --top N         Show top N matches (default: 5)
  --strategy NAME Match strategy to use (default: llm-fetch)
  --feedback      Record expected match for a URL
  --audit         List match history
  --diagnose      Deep diagnostic for a URL match`);
    process.exit(0);
  }

  // Route to subcommands
  if (flags.has("--feedback")) return cmdMatchFeedback();
  if (flags.has("--audit")) return cmdMatchAudit();
  if (flags.has("--diagnose")) return cmdMatchDiagnose();

  const url = positional[0];
  if (!url) {
    console.error("Usage: bookmark-index match <url> [hint]");
    process.exit(1);
  }

  const hint = positional[1] || null;
  const topN = parseInt(flagValues["--top"] || "5", 10);
  const noPrescore = flags.has("--no-prescore");
  const noCache = flags.has("--no-cache") || !!hint;
  const strategyName = flagValues["--strategy"] || "llm-fetch";

  if (hint) {
    log(`Hint provided: "${hint}" — cache will be skipped, hint-boosted search`);
  }

  const strategy = getStrategy(strategyName);
  log(`Using match strategy: ${strategy.name}`);

  const db = openDb();
  try {
    // Check cache
    const config = loadConfig();
    const cacheTtl = noCache ? 0 : (config.match.cache_ttl_minutes ?? 30);

    if (noCache) {
      log(hint ? "Cache skipped (hint provided)" : "Cache skipped (--no-cache)");
    } else {
      log(`Checking match cache (TTL: ${cacheTtl} minutes)...`);
    }
    if (cacheTtl > 0) {
      const cached = db
        .prepare(`SELECT result, cached_at FROM match_cache WHERE url = ?`)
        .get(url) as { result: string; cached_at: string } | null;

      if (cached) {
        const ageMs = Date.now() - new Date(cached.cached_at).getTime();
        if (ageMs < cacheTtl * 60_000) {
          log(`Cache hit (age: ${Math.round(ageMs / 1000)}s), returning cached result`);
          const { classification, matches } = JSON.parse(cached.result);
          printMatchResult(classification, matches);
          return;
        }
        log(`Cache expired (age: ${Math.round(ageMs / 1000)}s), will re-match`);
      } else {
        log("No cached result for this URL");
      }
    }

    // Load classified groups (via active version)
    log("Loading classified groups from index...");
    const groups = db
      .prepare(
        `SELECT g.id, g.source, g.name, c.category, c.topics, c.description, c.intent, g.last_active
         FROM groups g
         JOIN group_classifications c ON g.active_version = c.id
         WHERE g.active_version IS NOT NULL`
      )
      .all() as any[];

    if (groups.length === 0) {
      console.error("No classified groups. Run: bookmark-index classify --all");
      process.exit(1);
    }
    log(`Loaded ${groups.length} classified group(s)`);

    const apiKey = resolveApiKey(config.openrouter);
    console.error(`Fetching: ${url}...`);

    const result = await strategy.match({
      url,
      hint,
      db,
      config,
      groups,
      topN,
      noPrescore,
      verbose,
      log,
      apiKey,
    });

    const topMatches = result.matches.slice(0, topN);
    log(`Returning top ${topMatches.length} of ${result.matches.length} match(es)`);

    // Cache the result
    log("Caching result and logging match to history");
    if (cacheTtl > 0) {
      db.prepare(
        `INSERT OR REPLACE INTO match_cache (url, result, cached_at) VALUES (?, ?, ?)`
      ).run(url, JSON.stringify({ classification: result.classification, matches: topMatches }), new Date().toISOString());
    }

    // Log the match for diagnostics
    db.prepare(`
      INSERT INTO match_log (url, created_at, page_category, page_topics, page_description,
        candidate_count, candidates_sent, candidate_ids, prescore_cutoff, model,
        raw_response, match_results, top_match_group, top_match_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      url,
      new Date().toISOString(),
      result.classification?.category || null,
      result.classification?.topics ? JSON.stringify(result.classification.topics) : null,
      result.classification?.description || null,
      result.candidateCount,
      result.candidatesSent,
      JSON.stringify(result.candidateIds),
      result.prescoreCutoff,
      result.model,
      result.rawResponse,
      JSON.stringify(topMatches),
      topMatches[0]?.group || null,
      topMatches[0]?.score ?? null,
    );

    printMatchResult(result.classification, topMatches);
  } finally {
    db.close();
  }
}

function printMatchResult(classification: any, matches: any[]) {
  if (jsonMode) {
    console.log(JSON.stringify({ classification, matches }, null, 2));
  } else {
    if (classification) {
      console.log(`Page: ${classification.category} [${(classification.topics || []).join(", ")}]`);
      console.log(`  ${classification.description || ""}`);
      console.log();
    }
    if (matches.length === 0) {
      console.log("No matching groups found.");
    } else {
      console.log("Matches:");
      for (const m of matches) {
        const active = m.lastActive
          ? new Date(m.lastActive).toLocaleDateString()
          : "unknown";
        console.log(
          `  ${m.score.toFixed(2)}  [${m.source}] ${m.group}  (active: ${active})`
        );
        console.log(`         ${m.reason}`);
      }
    }
  }
}

// ─── MATCH --feedback ────────────────────────────────────────────────────────

function cmdMatchFeedback() {
  const url = positional[0];
  const expectedGroup = flagValues["--expected"];
  const feedbackType = flagValues["--type"] || "wrong_match";
  const notes = flagValues["--notes"] || null;

  if (!url || !expectedGroup) {
    console.error("Usage: bookmark-index match --feedback <url> --expected <group-name> [--type wrong_match|missing_match|correct|note] [--notes '...']");
    process.exit(1);
  }

  const validTypes = ["wrong_match", "missing_match", "correct", "note"];
  if (!validTypes.includes(feedbackType)) {
    console.error(`Invalid feedback type "${feedbackType}". Must be one of: ${validTypes.join(", ")}`);
    process.exit(1);
  }

  const db = openDb();
  try {
    // Find the expected group to get its source
    const group = resolveGroup(db, expectedGroup, "name, source");
    const expectedSource = group?.source || null;
    if (!group) {
      console.error(`Warning: group "${expectedGroup}" not found in index. Recording feedback anyway.`);
    }

    // Link to the most recent match_log entry for this URL
    const logEntry = db
      .prepare(`SELECT id FROM match_log WHERE url = ? ORDER BY created_at DESC LIMIT 1`)
      .get(url) as { id: number } | null;

    db.prepare(`
      INSERT INTO match_feedback (match_log_id, url, created_at, expected_group, expected_source, feedback_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      logEntry?.id || null,
      url,
      new Date().toISOString(),
      expectedGroup,
      expectedSource,
      feedbackType,
      notes,
    );

    console.error(`Feedback recorded: ${feedbackType} for ${url} → expected "${expectedGroup}"`);
  } finally {
    db.close();
  }
}

// ─── MATCH --audit ──────────────────────────────────────────────────────────

function cmdMatchAudit() {
  const db = openDb();
  try {
    const hasFeedback = flags.has("--has-feedback");
    const wrongOnly = flags.has("--wrong-only");

    let sql: string;
    if (hasFeedback || wrongOnly) {
      sql = `
        SELECT ml.id, ml.url, ml.created_at, ml.top_match_group, ml.top_match_score,
               ml.candidate_count, ml.candidates_sent, ml.prescore_cutoff,
               mf.expected_group, mf.feedback_type, mf.notes
        FROM match_log ml
        INNER JOIN match_feedback mf ON mf.match_log_id = ml.id
        ${wrongOnly ? `WHERE mf.feedback_type IN ('wrong_match', 'missing_match')` : ""}
        ORDER BY ml.created_at DESC
        LIMIT 50`;
    } else {
      sql = `
        SELECT ml.id, ml.url, ml.created_at, ml.top_match_group, ml.top_match_score,
               ml.candidate_count, ml.candidates_sent, ml.prescore_cutoff,
               mf.expected_group, mf.feedback_type, mf.notes
        FROM match_log ml
        LEFT JOIN match_feedback mf ON mf.match_log_id = ml.id
        ORDER BY ml.created_at DESC
        LIMIT 20`;
    }

    const rows = db.prepare(sql).all() as any[];

    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      if (rows.length === 0) {
        console.log("No match history found.");
        return;
      }
      for (const r of rows) {
        const date = new Date(r.created_at).toLocaleDateString();
        const score = r.top_match_score != null ? r.top_match_score.toFixed(2) : "?";
        const fb = r.feedback_type
          ? ` ← ${r.feedback_type}: expected "${r.expected_group}"`
          : "";
        console.log(`${date}  ${score}  ${r.top_match_group || "(none)"}  ${r.url}${fb}`);
      }
    }
  } finally {
    db.close();
  }
}

// ─── MATCH --diagnose ───────────────────────────────────────────────────────

async function cmdMatchDiagnose() {
  const url = positional[0];
  if (!url) {
    console.error("Usage: bookmark-index match --diagnose <url>");
    process.exit(1);
  }

  const db = openDb();
  try {
    // Get the most recent match log for this URL
    const logEntry = db
      .prepare(`SELECT * FROM match_log WHERE url = ? ORDER BY created_at DESC LIMIT 1`)
      .get(url) as any;

    if (!logEntry) {
      console.error(`No match history for "${url}". Run: bookmark-index match ${url}`);
      process.exit(1);
    }

    // Get any feedback
    const feedback = db
      .prepare(`SELECT * FROM match_feedback WHERE url = ? ORDER BY created_at DESC`)
      .all(url) as any[];

    // Parse stored data
    const candidateIds: number[] = logEntry.candidate_ids ? JSON.parse(logEntry.candidate_ids) : [];
    const matchResults = logEntry.match_results ? JSON.parse(logEntry.match_results) : [];

    const diagnosis: any = {
      url,
      match_date: logEntry.created_at,
      page_classification: {
        category: logEntry.page_category,
        topics: logEntry.page_topics ? JSON.parse(logEntry.page_topics) : [],
        description: logEntry.page_description,
      },
      candidate_stats: {
        total_classified: logEntry.candidate_count,
        sent_to_llm: logEntry.candidates_sent,
        prescore_cutoff: logEntry.prescore_cutoff,
      },
      top_matches: matchResults.slice(0, 5),
      feedback: feedback.map((f: any) => ({
        type: f.feedback_type,
        expected_group: f.expected_group,
        expected_source: f.expected_source,
        notes: f.notes,
        date: f.created_at,
      })),
    };

    // For each feedback entry, diagnose why the expected group wasn't matched
    for (const fb of feedback) {
      if (!fb.expected_group) continue;

      const expectedGroup = db
        .prepare(
          `SELECT id, source, name, category, topics, description, intent, last_active
           FROM groups WHERE name = ?
           ORDER BY CASE WHEN source = 'safari' THEN 0 ELSE 1 END`
        )
        .get(fb.expected_group) as any;

      if (!expectedGroup) {
        diagnosis[`diagnosis_${fb.expected_group}`] = { error: "Group not found in index" };
        continue;
      }

      const wasInCandidateSet = candidateIds.includes(expectedGroup.id);
      const wasInMatches = matchResults.some((m: any) =>
        m.group === expectedGroup.name && m.source === expectedGroup.source
      );

      // Re-compute pre-score for this group to show why it ranked where it did
      const groups = db
        .prepare(`SELECT id, source, name, category, topics, description, intent, last_active FROM groups WHERE classified_at IS NOT NULL`)
        .all() as any[];

      // Fetch page content to recompute signals (or use stored data)
      let pageSignals: PageSignals | null = null;
      let groupRank = -1;
      let groupPrescore = 0;

      try {
        // Re-fetch page to recompute signals (stored description is too sparse)
        let pageText: string;
        try {
          pageText = await fetchAndConvertToMarkdown(url, fetch);
        } catch {
          pageText = (logEntry.page_description || "") + " " + (logEntry.page_topics || "");
        }
        pageSignals = extractPageSignals(url, pageText);

        const domainGroupIds = new Set(
          (db.prepare(`SELECT DISTINCT group_id FROM items WHERE url LIKE '%' || ? || '%'`)
            .all(pageSignals.hostname) as { group_id: number }[]).map(r => r.group_id)
        );

        const scored = scoreGroupCandidates(groups, pageSignals, domainGroupIds);
        scored.sort((a, b) => b.localScore - a.localScore);

        const groupEntry = scored.find(s => s.group.id === expectedGroup.id);
        if (groupEntry) {
          groupPrescore = groupEntry.localScore;
          groupRank = scored.indexOf(groupEntry) + 1;
        }
      } catch {}

      const expectedTopics = expectedGroup.topics ? JSON.parse(expectedGroup.topics) : [];
      const pageTopics: string[] = logEntry.page_topics ? JSON.parse(logEntry.page_topics) : [];
      // Use word-splitting for overlap (same logic as pre-scoring)
      const allPageTopicWords = new Set(pageTopics.flatMap((t: string) => t.split("-").filter((p: string) => p.length > 2)));
      const topicOverlap = expectedTopics.filter((t: string) => {
        const parts = t.split("-").filter((p: string) => p.length > 2);
        return parts.some((part: string) =>
          allPageTopicWords.has(part) ||
          [...allPageTopicWords].some(pw => pw.includes(part) || part.includes(pw))
        );
      });

      let rootCause: string;
      if (!wasInCandidateSet) {
        rootCause = `CANDIDATE_SELECTION: Group was not in the candidate set (rank ${groupRank}/${groups.length}, pre-score ${groupPrescore.toFixed(3)}, cutoff was ${logEntry.prescore_cutoff?.toFixed(3) || "?"})`;
      } else if (!wasInMatches) {
        rootCause = `LLM_RANKING: Group was in the candidate set but the LLM did not select it as a match`;
      } else {
        const matchEntry = matchResults.find((m: any) => m.group === expectedGroup.name);
        rootCause = `LLM_SCORE: Group was matched but scored ${matchEntry?.score?.toFixed(2) || "?"} — may need better classification`;
      }

      diagnosis[`diagnosis_${fb.expected_group}`] = {
        expected_group: {
          id: expectedGroup.id,
          source: expectedGroup.source,
          name: expectedGroup.name,
          category: expectedGroup.category,
          topics: expectedTopics,
          description: expectedGroup.description,
        },
        was_in_candidate_set: wasInCandidateSet,
        was_in_llm_matches: wasInMatches,
        prescore_rank: groupRank,
        prescore_value: groupPrescore,
        topic_overlap_with_page: topicOverlap,
        root_cause: rootCause,
      };
    }

    if (jsonMode) {
      console.log(JSON.stringify(diagnosis, null, 2));
    } else {
      console.log(`Diagnosis for: ${url}`);
      console.log(`Matched: ${logEntry.created_at}`);
      console.log(`Model: ${logEntry.model}`);
      console.log();
      const pageTopicsList = logEntry.page_topics ? JSON.parse(logEntry.page_topics).join(", ") : "?";
      console.log(`Page: ${logEntry.page_category} [${pageTopicsList}]`);
      console.log(`  ${logEntry.page_description || ""}`);
      console.log();
      console.log(`Candidates: ${logEntry.candidates_sent} of ${logEntry.candidate_count} groups (cutoff: ${logEntry.prescore_cutoff?.toFixed(3) || "?"})`);
      console.log();

      if (matchResults.length > 0) {
        console.log("Top matches:");
        for (const m of matchResults.slice(0, 5)) {
          console.log(`  ${m.score?.toFixed(2) || "?"}  [${m.source}] ${m.group}`);
        }
        console.log();
      }

      if (feedback.length === 0) {
        console.log("No feedback recorded for this URL.");
        console.log(`Record feedback: bookmark-index match --feedback ${url} --expected "Group Name"`);
      } else {
        for (const fb of feedback) {
          console.log(`Feedback (${fb.feedback_type}): expected "${fb.expected_group}"`);
          if (fb.notes) console.log(`  Notes: ${fb.notes}`);

          const diag = diagnosis[`diagnosis_${fb.expected_group}`];
          if (diag && !diag.error) {
            console.log(`  Expected group: [${diag.expected_group.source}] ${diag.expected_group.name}`);
            console.log(`    Category: ${diag.expected_group.category} | Topics: ${JSON.stringify(diag.expected_group.topics)}`);
            console.log(`    In candidate set: ${diag.was_in_candidate_set ? "YES" : "NO"} (rank ${diag.prescore_rank}, pre-score ${diag.prescore_value.toFixed(3)})`);
            console.log(`    In LLM matches: ${diag.was_in_llm_matches ? "YES" : "NO"}`);
            console.log(`    Topic overlap with page: ${JSON.stringify(diag.topic_overlap_with_page)}`);
            console.log(`    Root cause: ${diag.root_cause}`);
          } else if (diag?.error) {
            console.log(`  ${diag.error}`);
          }
          console.log();
        }
      }
    }
  } finally {
    db.close();
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

// ─── BACKUP Command ─────────────────────────────────────────────────────────

function cmdBackup() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index backup — Checkpoint WAL and create a rotating backup

Usage: bookmark-index backup [--keep N] [--verbose]

Checkpoints the SQLite WAL into the main database file, then copies it
to a timestamped backup in the same directory. Old backups are pruned
to keep the most recent N (default: 3).

Options:
  --keep N     Number of backups to retain (default: 3)
  --verbose    Print debug info to stderr
  --help, -h   Show this help message`);
    process.exit(0);
  }

  const keep = parseInt(flagValues["--keep"] || "3", 10);
  const dbDir = dirname(DB_PATH);
  const dbBasename = DB_PATH.split("/").pop()!.replace(/\.db$/, "");

  log(`Database: ${DB_PATH}`);
  log(`Backup directory: ${dbDir}`);

  // Checkpoint WAL
  const db = openDb();
  try {
    log("Checkpointing WAL (FULL)...");
    const result = db.exec("PRAGMA wal_checkpoint(FULL)") as any;
    log("WAL checkpoint complete");
  } finally {
    db.close();
  }

  // Create timestamped backup
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/T/, "_")
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "");
  const backupName = `${dbBasename}.backup.${timestamp}.db`;
  const backupPath = join(dbDir, backupName);

  log(`Creating backup: ${backupName}`);
  copyFileSync(DB_PATH, backupPath);
  console.error(`Backup created: ${backupPath}`);

  // Rotate: find existing backups, delete oldest beyond keep limit
  const backupPattern = `${dbBasename}.backup.`;
  const allFiles = readdirSync(dbDir);
  const backups = allFiles
    .filter(f => f.startsWith(backupPattern) && f.endsWith(".db"))
    .sort()
    .reverse();

  log(`Found ${backups.length} backup(s), keeping ${keep}`);

  if (backups.length > keep) {
    const toDelete = backups.slice(keep);
    for (const old of toDelete) {
      const oldPath = join(dbDir, old);
      log(`Removing old backup: ${old}`);
      unlinkSync(oldPath);
      console.error(`Removed old backup: ${old}`);
    }
  }
}

// ─── VERSION Command ──────────────────────────────────────────────────────

function cmdVersion() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index version — Manage Collection Card versions

Usage: bookmark-index version <group-name>              List all versions
       bookmark-index version <group-name> set <number>  Set active version
       bookmark-index version <group-name> copy          Copy active version as a new draft`);
    process.exit(0);
  }

  const name = positional[0];
  if (!name) {
    console.error("Usage: bookmark-index version <collection-name> [set <number> | copy]");
    process.exit(1);
  }

  const subcommand = positional[1] || null; // "set", "copy", or null (list)

  const db = openDb();
  try {
    const group = resolveGroup(db, name);
    if (!group) {
      const matches = db.prepare(`SELECT name, source FROM groups WHERE name LIKE ?`).all(`%${name}%`) as any[];
      if (matches.length > 0) {
        console.error(`Group "${name}" not found. Did you mean:`);
        for (const m of matches) console.error(`  [${m.source}] ${m.name}`);
      } else {
        console.error(`Group "${name}" not found.`);
      }
      process.exit(1);
    }

    const versions = db.prepare(
      `SELECT id, version, confidence, author, created_at
       FROM group_classifications WHERE group_id = ? ORDER BY version`
    ).all(group.id) as { id: number; version: number; confidence: number; author: string; created_at: string }[];

    if (subcommand === "set") {
      const versionNum = positional[2] ? parseInt(positional[2], 10) : NaN;
      if (isNaN(versionNum)) {
        console.error("Usage: bookmark-index version <group-name> set <number>");
        process.exit(1);
      }

      if (versions.length === 0) {
        console.error(`No classification versions for "${group.name}".`);
        process.exit(1);
      }

      const target = versions.find(v => v.version === versionNum);
      if (!target) {
        console.error(`Version ${versionNum} not found. Available: ${versions.map(v => v.version).join(", ")}`);
        process.exit(1);
      }

      // Load full classification to update inline fields
      const cls = db.prepare(`SELECT * FROM group_classifications WHERE id = ?`).get(target.id) as any;
      db.prepare(`
        UPDATE groups SET
          active_version = ?,
          description = ?,
          category = ?,
          topics = ?,
          intent = ?,
          confidence = ?,
          classified_at = ?
        WHERE id = ?
      `).run(cls.id, cls.description, cls.category, cls.topics, cls.intent, cls.confidence, cls.created_at, group.id);

      console.log(`Set active version to v${versionNum} for "${group.name}"`);
    } else if (subcommand === "copy") {
      if (!group.active_version) {
        console.error(`No active classification to copy for "${group.name}".`);
        process.exit(1);
      }

      // Load active classification
      const active = db.prepare(`SELECT * FROM group_classifications WHERE id = ?`).get(group.active_version) as any;
      const maxVer = db.prepare(
        `SELECT COALESCE(MAX(version), 0) as max_ver FROM group_classifications WHERE group_id = ?`
      ).get(group.id) as { max_ver: number };
      const nextVersion = maxVer.max_ver + 1;
      const now = new Date().toISOString();
      const author = flagValues["--author"] || `copy of v${active.version}`;

      db.prepare(`
        INSERT INTO group_classifications (group_id, version, description, category, topics, intent, confidence, author, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(group.id, nextVersion, active.description, active.category, active.topics, active.intent, active.confidence, author, now);

      console.log(`Created v${nextVersion} for "${group.name}" (copied from v${active.version}, not yet active)`);
    } else if (subcommand === null) {
      // List all versions
      if (versions.length === 0) {
        console.error(`No classification versions for "${group.name}".`);
        process.exit(1);
      }

      console.log(`Versions for "${group.name}" [${group.source}]:`);
      for (const v of versions) {
        const active = group.active_version === v.id ? "  \u2190 active" : "";
        const conf = v.confidence != null ? v.confidence.toFixed(2) : "  - ";
        const date = v.created_at ? v.created_at.slice(0, 10) : "unknown";
        console.log(`  v${v.version}  ${conf}  ${v.author || "-"}  ${date}${active}`);
      }
    } else {
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error("Usage: bookmark-index version <collection-name> [set <number> | copy]");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ─── STATS Command ───────────────────────────────────────────────────────────

function cmdStats() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index stats — Show database path, collection counts, and cache freshness

Usage: bookmark-index stats [--json] [--db <path>]

Displays database location, collection counts by source, and cache file freshness.`);
    process.exit(0);
  }

  // Determine DB path source
  let dbSource: string;
  if (flagValues["--db"]) {
    dbSource = "CLI flag";
  } else {
    const configPath = resolveConfigPath();
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as any;
    if (parsed.database?.path) {
      dbSource = `config file (\`${configPath}\`)`;
    } else {
      dbSource = "XDG default";
    }
  }

  const db = openDb();
  try {
    // Group counts by source
    const rows = db.prepare(
      `SELECT g.source, COUNT(*) as total,
              SUM(CASE WHEN g.active_version IS NOT NULL THEN 1 ELSE 0 END) as classified,
              (SELECT COUNT(*) FROM items i JOIN groups g2 ON i.group_id = g2.id WHERE g2.source = g.source) as urls
       FROM groups g GROUP BY g.source`
    ).all() as { source: string; total: number; classified: number; urls: number }[];

    const groups: Record<string, { total: number; classified: number; urls: number }> = {};
    let grandTotal = 0;
    let grandClassified = 0;
    let grandUrls = 0;
    for (const r of rows) {
      groups[r.source] = { total: r.total, classified: r.classified, urls: r.urls };
      grandTotal += r.total;
      grandClassified += r.classified;
      grandUrls += r.urls;
    }

    // Cache freshness
    const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    const cacheDir = join(xdgCache, "safari-tabgroups");
    const cacheFiles: Record<string, { path: string; label: string }> = {
      safari: { path: join(cacheDir, "SafariTabs.db"), label: "Safari" },
      raindrop: { path: join(cacheDir, "raindrop-collections.json"), label: "Raindrop" },
    };

    const cache: Record<string, { path: string; lastSynced: string | null }> = {};
    for (const [key, { path }] of Object.entries(cacheFiles)) {
      try {
        const st = statSync(path);
        cache[key] = { path, lastSynced: st.mtime.toISOString().replace("T", " ").slice(0, 19) };
      } catch {
        cache[key] = { path, lastSynced: null };
      }
    }

    // Last indexed timestamp from meta table
    const lastIndexedRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_indexed'`).get() as { value: string } | null;
    const lastIndexed = lastIndexedRow?.value?.replace("T", " ").slice(0, 19) ?? null;

    if (jsonMode) {
      console.log(JSON.stringify({
        database: { path: DB_PATH, source: dbSource, lastIndexed },
        groups,
        cache,
      }, null, 2));
    } else {
      console.log(`Database: ${DB_PATH} (from ${dbSource})`);
      console.log(`Last indexed: ${lastIndexed || "never"}`);
      console.log();
      console.log("Groups:");
      const sources = Object.keys(groups).sort();
      const pad = Math.max(...sources.map(s => s.length), 5);
      for (const s of sources) {
        const g = groups[s];
        console.log(`  ${s.padEnd(pad)}  ${String(g.total).padStart(3)} groups (${g.classified} classified), ${g.urls} urls`);
      }
      console.log(`  ${"total".padEnd(pad)}  ${String(grandTotal).padStart(3)} groups (${grandClassified} classified), ${grandUrls} urls`);
      console.log();
      console.log("Cache:");
      for (const [key, { label }] of Object.entries(cacheFiles)) {
        const c = cache[key];
        const synced = c.lastSynced || "not found";
        console.log(`  ${label.padEnd(10)} ${c.path}`);
        console.log(`  ${"".padEnd(10)} last synced ${synced}`);
      }
    }
  } finally {
    db.close();
  }
}

switch (command) {
  case "update":
    await cmdUpdate();
    break;
  case "list":
    cmdList();
    break;
  case "show":
    cmdShow();
    break;
  case "classify":
    await cmdClassify();
    break;
  case "match":
    await cmdMatch();
    break;
  case "backup":
    cmdBackup();
    break;
  case "version":
    cmdVersion();
    break;
  case "stats":
    cmdStats();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run bookmark-index --help for usage.");
    process.exit(1);
}
