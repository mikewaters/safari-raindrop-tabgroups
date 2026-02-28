#!/usr/bin/env bun

/**
 * bookmark-index — Unified index of Safari tab groups and Raindrop collections.
 *
 * Maintains a local SQLite database (bookmarks.db) that stores tab groups,
 * collections, their child tabs/bookmarks, and LLM-generated classifications.
 * Supports matching new URLs against stored classifications.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { fetchAndConvertToMarkdown } from "scrape2md";
import { getTabLastActive, getDateAdded } from "./plist.ts";

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

const HELP = `bookmark-index — Unified index of Safari tab groups and Raindrop collections

Usage: bookmark-index <command> [options]

Commands:
  update     Sync index from cached Safari/Raindrop data
  list       List indexed groups with classification status
  show       Show full detail for a group
  classify   Classify a group using LLM (via describe-tabgroup)
  match      Find matching groups for a URL

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
  if (arg === "--top" || arg === "--db") {
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

  const configPath = join(import.meta.dir, "..", "fetch.config.toml");
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
  `);
  return db;
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
  const configPath = join(import.meta.dir, "..", "fetch.config.toml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as any;
  return {
    openrouter: parsed.openrouter,
    match: parsed.match || {
      system_prompt: DEFAULT_MATCH_PROMPT,
      max_groups_in_prompt: 30,
      max_page_bytes: 20000,
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
Adds new groups, updates existing ones, and removes groups deleted from source.`);
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

  const upsertGroup = db.prepare(`
    INSERT INTO groups (source, source_id, name, profile, tab_count, last_active, created_at, updated_at)
    VALUES ('safari', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      name = excluded.name,
      profile = excluded.profile,
      tab_count = excluded.tab_count,
      last_active = excluded.last_active,
      created_at = COALESCE(excluded.created_at, groups.created_at),
      updated_at = excluded.updated_at
  `);

  const upsertItem = db.prepare(`
    INSERT INTO items (group_id, title, url, last_active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, url) DO UPDATE SET
      title = excluded.title,
      last_active = excluded.last_active,
      created_at = COALESCE(excluded.created_at, items.created_at)
  `);

  const getGroupId = db.prepare(
    `SELECT id FROM groups WHERE source = 'safari' AND source_id = ?`
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

      // Check if this is an insert or update
      const existing = getGroupId.get(sourceId) as { id: number } | null;
      const isNew = !existing;

      // Upsert the group
      upsertGroup.run(
        sourceId,
        group.name,
        profile.name,
        group.tabs.length,
        groupLastActive,
        groupCreatedAt,
        now
      );

      // Get the group's row ID in our index
      const groupRow2 = getGroupId.get(sourceId) as { id: number };
      const groupId = groupRow2.id;

      // Replace items: delete existing, insert current
      deleteItemsForGroup.run(groupId);
      for (const tab of tabTimestamps) {
        upsertItem.run(
          groupId,
          tab.title,
          tab.url,
          tab.lastActive,
          tab.createdAt
        );
      }

      if (isNew) added++;
      else updated++;
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

  const upsertGroup = db.prepare(`
    INSERT INTO groups (source, source_id, name, tab_count, last_active, created_at, updated_at)
    VALUES ('raindrop', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      name = excluded.name,
      tab_count = excluded.tab_count,
      last_active = excluded.last_active,
      created_at = COALESCE(excluded.created_at, groups.created_at),
      updated_at = excluded.updated_at
  `);

  const upsertItem = db.prepare(`
    INSERT INTO items (group_id, title, url, last_active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, url) DO UPDATE SET
      title = excluded.title,
      last_active = excluded.last_active,
      created_at = COALESCE(excluded.created_at, items.created_at)
  `);

  const getGroupId = db.prepare(
    `SELECT id FROM groups WHERE source = 'raindrop' AND source_id = ?`
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
    seenSourceIds.add(sourceId);

    const existing = getGroupId.get(sourceId) as { id: number } | null;
    const isNew = !existing;

    upsertGroup.run(
      sourceId,
      fullTitle(col),
      colRaindrops.length,
      col.lastUpdate || null,
      col.created || null,
      now
    );

    const groupRow = getGroupId.get(sourceId) as { id: number };
    const groupId = groupRow.id;

    deleteItemsForGroup.run(groupId);
    for (const r of colRaindrops) {
      if (!r.link) continue;
      upsertItem.run(
        groupId,
        r.title || "(untitled)",
        r.link,
        r.lastUpdate || null,
        r.created || null
      );
    }

    if (isNew) added++;
    else updated++;
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
    console.log(`bookmark-index list — List indexed groups

Usage: bookmark-index list [--json] [--safari] [--raindrop] [--verbose]

Lists all indexed groups with their classification status and recency.`);
    process.exit(0);
  }

  const db = openDb();
  try {
    let sql = `SELECT id, source, name, profile, tab_count, last_active, category, classified_at
               FROM groups`;
    const conditions: string[] = [];
    if (flags.has("--safari") && !flags.has("--raindrop"))
      conditions.push(`source = 'safari'`);
    if (flags.has("--raindrop") && !flags.has("--safari"))
      conditions.push(`source = 'raindrop'`);
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY last_active DESC NULLS LAST`;

    const rows = db.prepare(sql).all() as any[];

    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      if (rows.length === 0) {
        console.log("No groups indexed. Run: bookmark-index update");
        return;
      }
      for (const r of rows) {
        const classified = r.classified_at ? r.category || "yes" : "-";
        const active = r.last_active
          ? new Date(r.last_active).toLocaleDateString()
          : "unknown";
        const profile = r.profile ? ` (${r.profile})` : "";
        console.log(
          `[${r.source}] ${r.name}${profile}  |  ${r.tab_count} tabs  |  active: ${active}  |  classified: ${classified}`
        );
      }
    }
  } finally {
    db.close();
  }
}

// ─── SHOW Command ────────────────────────────────────────────────────────────

function cmdShow() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index show — Show full group detail

Usage: bookmark-index show <group-name> [--json] [--verbose]

Shows a group's classification, tabs, and metadata.`);
    process.exit(0);
  }

  const name = positional[0];
  if (!name) {
    console.error("Usage: bookmark-index show <group-name>");
    process.exit(1);
  }

  const db = openDb();
  try {
    const group = db
      .prepare(`SELECT * FROM groups WHERE name = ?`)
      .get(name) as any;

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

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            ...group,
            topics: group.topics ? JSON.parse(group.topics) : null,
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
      if (group.description) {
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
    console.log(`bookmark-index classify — Classify groups using LLM

Usage: bookmark-index classify <group-name> [--fetch] [--force] [--verbose]
       bookmark-index classify --all [--unclassified] [--force] [--fetch] [--verbose]

Classifies groups by delegating to describe-tabgroup.
Results are stored in the index database.
--force re-classifies even if already classified.
--unclassified only classifies groups without existing classification.`);
    process.exit(0);
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

  const db = openDb();
  try {
    let groups: { id: number; name: string; source: string; classified_at: string | null }[];

    if (all) {
      let sql = `SELECT id, name, source, classified_at FROM groups`;
      if (unclassifiedOnly) sql += ` WHERE classified_at IS NULL`;
      sql += ` ORDER BY id`;
      groups = db.prepare(sql).all() as any[];
    } else {
      const group = db
        .prepare(`SELECT id, name, source, classified_at FROM groups WHERE name = ?`)
        .get(name!) as any;
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
        const now = new Date().toISOString();

        db.prepare(`
          UPDATE groups SET
            description = ?,
            category = ?,
            topics = ?,
            intent = ?,
            confidence = ?,
            classified_at = ?
          WHERE id = ?
        `).run(
          result.description || null,
          result.category || null,
          result.topics ? JSON.stringify(result.topics) : null,
          result.intent || null,
          result.confidence ?? null,
          now,
          group.id
        );

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

// ─── MATCH Command ───────────────────────────────────────────────────────────

async function cmdMatch() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index match — Find matching groups for a URL

Usage: bookmark-index match <url> [--json] [--top N] [--verbose]

Fetches the URL, classifies it with an LLM, then matches against
stored group classifications using topic/category overlap + recency.`);
    process.exit(0);
  }

  const url = positional[0];
  if (!url) {
    console.error("Usage: bookmark-index match <url>");
    process.exit(1);
  }

  const topN = parseInt(flagValues["--top"] || "5", 10);

  const db = openDb();
  try {
    // Load classified groups
    const groups = db
      .prepare(
        `SELECT id, source, name, category, topics, description, intent, last_active
         FROM groups WHERE classified_at IS NOT NULL`
      )
      .all() as any[];

    if (groups.length === 0) {
      console.error("No classified groups. Run: bookmark-index classify --all");
      process.exit(1);
    }

    // Fetch URL markdown
    console.error(`Fetching: ${url}...`);
    let markdown: string;
    try {
      markdown = await fetchAndConvertToMarkdown(url, fetch);
    } catch (err) {
      console.error(`Failed to fetch URL: ${err}`);
      process.exit(1);
    }

    // Load config and classify the URL
    const config = loadConfig();
    const apiKey = resolveApiKey(config.openrouter);
    const truncated = markdown.slice(0, config.match.max_page_bytes);

    // Build candidate list for context
    const candidateLines = groups
      .slice(0, config.match.max_groups_in_prompt)
      .map(
        (g: any, i: number) =>
          `${i + 1}. [${g.source}] "${g.name}" — ${g.category} | topics: ${g.topics || "[]"} | ${g.description || "no description"}`
      )
      .join("\n");

    const userMessage = `## Web Page URL
${url}

## Web Page Content
${truncated}

## Candidate Groups
${candidateLines}`;

    log("Calling LLM for URL classification + matching...");

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.openrouter.model,
          ...(config.openrouter.max_tokens
            ? { max_tokens: config.openrouter.max_tokens }
            : {}),
          messages: [
            { role: "system", content: config.match.system_prompt },
            { role: "user", content: userMessage },
          ],
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(`OpenRouter API error (${response.status}): ${body}`);
      process.exit(1);
    }

    const llmData = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const raw = llmData.choices[0].message.content.trim();
    let result: {
      classification?: any;
      matches?: { group: string; source: string; score: number; reason: string }[];
    };

    try {
      const jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      result = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse LLM response:");
      console.error(raw);
      process.exit(1);
    }

    // Apply recency weighting
    const matches = (result.matches || []).map((m) => {
      const group = groups.find(
        (g: any) => g.name === m.group && g.source === m.source
      );
      const boost = group?.last_active ? recencyBoost(group.last_active) : 0;
      return {
        ...m,
        rawScore: m.score,
        score: Math.min(1.0, m.score + boost),
        lastActive: group?.last_active || null,
      };
    });

    matches.sort((a, b) => b.score - a.score);
    const topMatches = matches.slice(0, topN);

    if (jsonMode) {
      console.log(
        JSON.stringify(
          { classification: result.classification, matches: topMatches },
          null,
          2
        )
      );
    } else {
      if (result.classification) {
        console.log(`Page: ${result.classification.category} [${(result.classification.topics || []).join(", ")}]`);
        console.log(`  ${result.classification.description || ""}`);
        console.log();
      }
      if (topMatches.length === 0) {
        console.log("No matching groups found.");
      } else {
        console.log("Matches:");
        for (const m of topMatches) {
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
  } finally {
    db.close();
  }
}

function recencyBoost(lastActive: string): number {
  const daysAgo =
    (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo <= 7) return 0.15;
  if (daysAgo <= 30) return 0.1;
  if (daysAgo <= 90) return 0.05;
  return 0;
}

// ─── Router ──────────────────────────────────────────────────────────────────

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
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run bookmark-index --help for usage.");
    process.exit(1);
}
