#!/usr/bin/env bun

/**
 * bookmark-index — Unified index of Safari tab groups and Raindrop collections.
 *
 * Maintains a local SQLite database (bookmarks.db) that stores tab groups,
 * collections, their child tabs/bookmarks, and versioned Collection Cards.
 * Supports matching new URLs against stored Collection Cards.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { fetchAndConvertToMarkdown } from "scrape2md";
import { getTabLastActive, getDateAdded } from "./plist.ts";
import { resolveConfigPath } from "./config.ts";
import {
  normalizeStringArray,
  parseCollectionCard,
  parseJsonStringArray,
  stringifyCollectionCard,
  type CollectionCard,
} from "./cards/types";
import { getStrategy } from "./match/types";
import "./match/llm-fetch";
import {
  extractCardPageSignals,
  scoreCollectionCardCandidates,
  type CardPageSignals,
} from "./match/card-match";
import {
  dotProduct,
  embedTextsWithConfig,
  extractItemSignals,
  meanVector,
  parseVector,
  selectExemplars,
  serializeVector,
} from "./retrieval/local-embedding";
import {
  diffCollectionCards,
  evaluateCollectionDrift,
  parseSignature,
  summarizeMetrics,
  summarizeTopTerms,
} from "./review/analysis";

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

const HELP = `bookmark-index — Unified index of Safari tab groups and Raindrop collections

Usage: bookmark-index <command> [options]

Commands:
  update     Sync index from cached Safari/Raindrop data
  list       List indexed groups with Collection Card status
  show       Show full detail for a group
  classify   Generate or import a Collection Card
  enrich     Build retrieval signals and collection representations
  match      Find matching groups for a URL
  review     Inspect and resolve Collection Card review queue items
  metrics    Report match quality and drift metrics
  version    List, set, or copy Collection Card versions for a group
  backup     Checkpoint WAL and create a rotating backup of the database
  stats      Show database path, group counts, and cache freshness

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
const VALUE_FLAGS = new Set([
  "--top",
  "--db",
  "--expected",
  "--type",
  "--notes",
  "--author",
  "--strategy",
  "--keep",
  "--days",
]);

for (let i = 1; i < argv.length; i++) {
  const arg = argv[i];
  if (VALUE_FLAGS.has(arg)) {
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

const REQUIRED_SCHEMA: Record<string, string[]> = {
  groups: [
    "id",
    "source",
    "source_id",
    "name",
    "profile",
    "tab_count",
    "last_active",
    "created_at",
    "active_version",
    "updated_at",
  ],
  items: [
    "id",
    "group_id",
    "title",
    "url",
    "last_active",
    "created_at",
    "normalized_url",
    "signal_pack_text",
    "embedding_vector",
    "embedding_model_version",
    "extracted_keyphrases",
    "extracted_entities",
    "signals_updated_at",
  ],
  meta: ["key", "value"],
  match_cache: ["url", "result", "cached_at"],
  match_log: [
    "id",
    "url",
    "created_at",
    "page_signal_excerpt",
    "page_keyphrases",
    "candidate_count",
    "candidates_sent",
    "candidate_ids",
    "prescore_cutoff",
    "strategy_name",
    "model",
    "raw_response",
    "match_results",
    "top_match_group",
    "top_match_score",
    "top1_margin",
    "topk_entropy",
    "is_ambiguous",
  ],
  match_feedback: [
    "id",
    "match_log_id",
    "url",
    "created_at",
    "expected_group",
    "expected_source",
    "feedback_type",
    "notes",
  ],
  group_classifications: [
    "id",
    "group_id",
    "version",
    "definition",
    "includes_json",
    "excludes_json",
    "keyphrases_json",
    "representative_entities_json",
    "generated_by",
    "model_version",
    "last_generated_at",
    "last_reviewed_at",
    "author",
    "created_at",
    "card_schema_version",
  ],
  collection_representations: [
    "group_id",
    "centroid_vector",
    "exemplar_vectors",
    "embedding_model_version",
    "source_item_count",
    "keyword_signature",
    "entity_signature",
    "last_drift_score",
    "updated_at",
  ],
  collection_review_queue: [
    "group_id",
    "status",
    "priority",
    "reasons_json",
    "drift_score",
    "confusion_count",
    "ambiguity_rate",
    "queued_at",
    "updated_at",
    "reviewed_at",
    "reviewed_version",
    "resolution_notes",
  ],
};

function assertSupportedSchema(db: Database): void {
  const errors: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    const rows = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (rows.length === 0) {
      errors.push(`missing table "${table}"`);
      continue;
    }
    const actualColumns = new Set(rows.map((row) => row.name));
    for (const column of requiredColumns) {
      if (!actualColumns.has(column)) {
        errors.push(`table "${table}" is missing column "${column}"`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Unsupported database schema at ${DB_PATH}.`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error("Delete the database file and rerun: bookmark-index update");
    process.exit(1);
  }
}

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
      active_version INTEGER REFERENCES group_classifications(id),
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
      normalized_url TEXT,
      signal_pack_text TEXT,
      embedding_vector TEXT,
      embedding_model_version TEXT,
      extracted_keyphrases TEXT,
      extracted_entities TEXT,
      signals_updated_at TEXT,
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
      page_signal_excerpt TEXT,
      page_keyphrases  TEXT,
      candidate_count  INTEGER,
      candidates_sent  INTEGER,
      candidate_ids    TEXT,
      prescore_cutoff  REAL,
      strategy_name    TEXT,
      model            TEXT,
      raw_response     TEXT,
      match_results    TEXT,
      top_match_group  TEXT,
      top_match_score  REAL,
      top1_margin      REAL,
      topk_entropy     REAL,
      is_ambiguous     INTEGER
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
      definition  TEXT,
      includes_json TEXT NOT NULL,
      excludes_json TEXT NOT NULL,
      keyphrases_json TEXT NOT NULL,
      representative_entities_json TEXT NOT NULL,
      generated_by TEXT NOT NULL CHECK(generated_by IN ('system','manual')),
      model_version TEXT,
      last_generated_at TEXT,
      last_reviewed_at TEXT,
      author      TEXT,
      card_schema_version INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      UNIQUE(group_id, version)
    );
    CREATE TABLE IF NOT EXISTS collection_representations (
      group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      centroid_vector TEXT,
      exemplar_vectors TEXT,
      embedding_model_version TEXT,
      source_item_count INTEGER NOT NULL DEFAULT 0,
      keyword_signature TEXT,
      entity_signature TEXT,
      last_drift_score REAL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_review_queue (
      group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('open','approved','dismissed')),
      priority REAL NOT NULL DEFAULT 0,
      reasons_json TEXT NOT NULL,
      drift_score REAL NOT NULL DEFAULT 0,
      confusion_count INTEGER NOT NULL DEFAULT 0,
      ambiguity_rate REAL NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      ,
      reviewed_at TEXT,
      reviewed_version INTEGER,
      resolution_notes TEXT
    );
  `);
  assertSupportedSchema(db);
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
  ambiguity_margin_threshold: number;
  ambiguity_entropy_threshold: number;
  ambiguity_top_k: number;
}

interface OpenRouterConfig {
  api_key: string;
  model: string;
  system_prompt: string;
  max_content_bytes: number;
  max_tokens?: number;
}

interface DescribeConfig {
  system_prompt: string;
}

interface EnrichConfig {
  embedding_model_version: string;
  vector_dimensions: number;
  max_keyphrases_per_item: number;
  max_entities_per_item: number;
  max_exemplars: number;
  transformers_model_id: string;
  transformers_dtype: string;
  cache_dir: string;
  allow_remote_models: boolean;
  local_model_path: string | null;
}

interface ReviewConfig {
  drift_threshold: number;
  centroid_shift_threshold: number;
  keyword_shift_threshold: number;
  confusion_threshold: number;
  ambiguity_threshold: number;
  lookback_days: number;
}

function resolveOptionalPath(value: string | null | undefined): string | null {
  if (!value) return null;
  let resolved = value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => {
    if (name === "XDG_CACHE_HOME") {
      return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    }
    return process.env[name] || "";
  });
  if (resolved.startsWith("~")) {
    resolved = join(homedir(), resolved.slice(1));
  }
  return resolved;
}

function loadConfig(): {
  openrouter: OpenRouterConfig;
  match: MatchConfig;
  describe: DescribeConfig;
  enrich: EnrichConfig;
  review: ReviewConfig;
} {
  const configPath = resolveConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as any;
  const enrich = {
    embedding_model_version: "local-minilm-l6-v2",
    vector_dimensions: 384,
    max_keyphrases_per_item: 8,
    max_entities_per_item: 8,
    max_exemplars: 5,
    transformers_model_id: "Xenova/all-MiniLM-L6-v2",
    transformers_dtype: "q8",
    cache_dir: join(homedir(), ".cache", "safari-tabgroups", "transformers"),
    allow_remote_models: true,
    local_model_path: null,
    ...parsed.enrich,
  };
  enrich.cache_dir = resolveOptionalPath(enrich.cache_dir) || "";
  enrich.local_model_path = resolveOptionalPath(enrich.local_model_path);
  return {
    openrouter: parsed.openrouter,
    match: {
      system_prompt: DEFAULT_MATCH_PROMPT,
      max_groups_in_prompt: 30,
      max_page_bytes: 20000,
      cache_ttl_minutes: 30,
      ambiguity_margin_threshold: 0.05,
      ambiguity_entropy_threshold: 1.6,
      ambiguity_top_k: 5,
      ...parsed.match,
    },
    describe: parsed.describe,
    enrich,
    review: {
      drift_threshold: 0.28,
      centroid_shift_threshold: 0.2,
      keyword_shift_threshold: 0.35,
      confusion_threshold: 2,
      ambiguity_threshold: 0.4,
      lookback_days: 30,
      ...parsed.review,
    },
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

const DEFAULT_MATCH_PROMPT = `You are a research librarian. A user has found a web page and wants to know which of their existing Collection Cards it best fits into.

Given the web page content and a list of candidate Collection Cards, return the best matches.

Respond with ONLY a JSON object (no markdown fences):
{
  "matches": [
    {"group": "<exact group name>", "source": "safari|raindrop", "score": 0.0-1.0, "reason": "why this matches"}
  ]
}

Order matches by score descending. Include only groups scoring above 0.3.`;

function isoLookback(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseMatchGroupNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === "object" && typeof entry.group === "string"
          ? entry.group.trim()
          : null
      )
      .filter((value): value is string => !!value);
  } catch {
    return [];
  }
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

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
    console.log(`bookmark-index list — List indexed groups

Usage: bookmark-index list [--json] [--safari] [--raindrop] [--verbose]

Lists all indexed groups with their Collection Card status and recency.`);
    process.exit(0);
  }

  const db = openDb();
  try {
    let sql = `SELECT g.id, g.source, g.name, g.profile, g.tab_count, g.last_active,
                      g.active_version,
                      (SELECT COUNT(*) FROM group_classifications gc WHERE gc.group_id = g.id) as version_count
               FROM groups g`;
    const conditions: string[] = [];
    if (flags.has("--safari") && !flags.has("--raindrop"))
      conditions.push(`g.source = 'safari'`);
    if (flags.has("--raindrop") && !flags.has("--safari"))
      conditions.push(`g.source = 'raindrop'`);
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY g.last_active DESC NULLS LAST`;

    const rows = db.prepare(sql).all() as any[];

    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      if (rows.length === 0) {
        console.log("No groups indexed. Run: bookmark-index update");
        return;
      }
      for (const r of rows) {
        const cardStatus = r.active_version ? `v${r.version_count}` : "-";
        const active = r.last_active
          ? new Date(r.last_active).toLocaleDateString()
          : "unknown";
        const profile = r.profile ? ` (${r.profile})` : "";
        console.log(
          `[${r.source}] ${r.name}${profile}  |  ${r.tab_count} tabs  |  active: ${active}  |  card: ${cardStatus}`
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

Shows a group's Collection Card, tabs, and metadata.`);
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

    // Load active Collection Card version info
    let activeCard: any = null;
    let versionInfo = "";
    if (group.active_version) {
      activeCard = db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM group_classifications WHERE group_id = c.group_id) as total_versions
         FROM group_classifications c WHERE c.id = ?`
      ).get(group.active_version);
      if (activeCard) {
        versionInfo = ` (v${activeCard.version} of ${activeCard.total_versions})`;
      }
    }

    if (jsonMode) {
      const collectionCard = activeCard
        ? parseCollectionCard(activeCard)
        : null;
      console.log(
        JSON.stringify(
          {
            ...group,
            collection_card: collectionCard,
            version: activeCard?.version ?? null,
            total_versions: activeCard?.total_versions ?? 0,
            author: activeCard?.author ?? null,
            generated_by: activeCard?.generated_by ?? null,
            model_version: activeCard?.model_version ?? null,
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
      if (activeCard) {
        const collectionCard = parseCollectionCard(activeCard);
        console.log(`\nCollection Card${versionInfo} (${activeCard.created_at}):`);
        console.log(`  Definition: ${collectionCard.definition}`);
        console.log(`  Includes: ${collectionCard.includes.join(" | ") || "-"}`);
        console.log(`  Excludes: ${collectionCard.excludes.join(" | ") || "-"}`);
        console.log(`  Keyphrases: ${collectionCard.keyphrases.join(", ") || "-"}`);
        console.log(
          `  Representative entities: ${collectionCard.representative_entities.join(", ") || "-"}`
        );
        console.log(`  Generated by: ${activeCard.generated_by}`);
        console.log(`  Model version: ${activeCard.model_version || "-"}`);
        console.log(`  Author: ${activeCard.author || "-"}`);
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
    console.log(`bookmark-index classify — Generate Collection Cards using LLM

Usage: bookmark-index classify <group-name> [--fetch] [--force] [--verbose]
       bookmark-index classify --all [--unclassified] [--force] [--fetch] [--verbose]
       bookmark-index classify --import <group-name>
       bookmark-index classify --import --all

Generates Collection Cards by delegating to describe-tabgroup.
Results are stored in the index database.
--force regenerates even if a Collection Card already exists.
--unclassified only generates cards for groups without an active card.
--import reads Collection Card JSON from stdin instead of calling the LLM.
  Single: echo '{"definition":"...","includes":["..."],"excludes":["..."],"keyphrases":["..."],"representative_entities":["..."]}' | bookmark-index classify --import "Name"
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
    let groups: { id: number; name: string; source: string; active_version: number | null }[];

    if (all) {
      let sql = `SELECT id, name, source, active_version FROM groups`;
      if (unclassifiedOnly) sql += ` WHERE active_version IS NULL`;
      sql += ` ORDER BY id`;
      groups = db.prepare(sql).all() as any[];
    } else {
      const group = resolveGroup(db, name!, "id, name, source, active_version");
      if (!group) {
        console.error(`Group "${name}" not found in index.`);
        process.exit(1);
      }
      groups = [group];
    }

    let classified = 0;
    for (const group of groups) {
      if (group.active_version && !force) {
        log(`Skipping "${group.name}" (already has a Collection Card)`);
        continue;
      }

      console.error(`Generating Collection Card: ${group.name}...`);

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
        const warnings = validateCollectionCard(result);
        if (warnings.length > 0) {
          console.error(`  Invalid Collection Card for "${group.name}": ${warnings.join("; ")}`);
          continue;
        }
        const config = loadConfig();
        storeCollectionCard(db, group.id, result, {
          author: `openrouter/${config.openrouter.model}`,
          generatedBy: "system",
          modelVersion: config.openrouter.model,
          lastGeneratedAt: new Date().toISOString(),
          lastReviewedAt: null,
        });

        classified++;
        console.error(
          `  ${group.name} → ${(normalizeStringArray(result.keyphrases).slice(0, 5) || []).join(", ")}`
        );
      } catch (err) {
        console.error(`  Failed to parse describe output for "${group.name}": ${err}`);
        log(`  Raw output: ${stdout}`);
      }
    }

    console.error(`Generated ${classified} Collection Card(s).`);
  } finally {
    db.close();
  }
}

// ─── CLASSIFY --import ───────────────────────────────────────────────────────

const REQUIRED_COLLECTION_CARD_FIELDS = [
  "definition",
  "includes",
  "excludes",
  "keyphrases",
  "representative_entities",
] as const;

function validateCollectionCard(obj: any): string[] {
  const warnings: string[] = [];

  for (const field of REQUIRED_COLLECTION_CARD_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      warnings.push(`missing required field "${field}"`);
    }
  }
  if (warnings.length > 0) return warnings;

  if (typeof obj.definition !== "string" || obj.definition.trim().length < 200) {
    warnings.push(`"definition" must be a string at least 200 characters long`);
  }

  const arrayFields: Array<keyof CollectionCard> = [
    "includes",
    "excludes",
    "keyphrases",
    "representative_entities",
  ];
  for (const field of arrayFields) {
    const values = normalizeStringArray(obj[field]);
    if (!Array.isArray(obj[field])) {
      warnings.push(`"${field}" must be an array`);
      continue;
    }
    if (values.length !== obj[field].length) {
      warnings.push(`"${field}" must contain only non-empty strings`);
    }
  }

  if (normalizeStringArray(obj.keyphrases).length < 5) {
    warnings.push(`"keyphrases" must contain at least 5 entries`);
  }
  if (normalizeStringArray(obj.representative_entities).length < 3) {
    warnings.push(`"representative_entities" must contain at least 3 entries`);
  }

  return warnings;
}

function toCollectionCard(input: any): CollectionCard {
  return {
    definition: String(input.definition || "").trim(),
    includes: normalizeStringArray(input.includes),
    excludes: normalizeStringArray(input.excludes),
    keyphrases: normalizeStringArray(input.keyphrases),
    representative_entities: normalizeStringArray(input.representative_entities),
  };
}

function storeCollectionCard(
  db: Database,
  groupId: number,
  input: any,
  options: {
    author: string;
    generatedBy: "system" | "manual";
    modelVersion: string | null;
    lastGeneratedAt: string | null;
    lastReviewedAt: string | null;
  }
): void {
  const now = new Date().toISOString();
  const card = toCollectionCard(input);
  const serialized = stringifyCollectionCard(card);

  const row = db.prepare(
    `SELECT COALESCE(MAX(version), 0) as max_ver FROM group_classifications WHERE group_id = ?`
  ).get(groupId) as { max_ver: number };
  const nextVersion = row.max_ver + 1;

  const info = db.prepare(`
    INSERT INTO group_classifications (
      group_id, version, definition, includes_json, excludes_json, keyphrases_json,
      representative_entities_json, generated_by, model_version, last_generated_at,
      last_reviewed_at, author, created_at, card_schema_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    groupId,
    nextVersion,
    card.definition,
    serialized.includes_json,
    serialized.excludes_json,
    serialized.keyphrases_json,
    serialized.representative_entities_json,
    options.generatedBy,
    options.modelVersion,
    options.lastGeneratedAt,
    options.lastReviewedAt,
    options.author,
    now,
  );

  db.prepare(`UPDATE groups SET active_version = ?, updated_at = ? WHERE id = ?`).run(
    info.lastInsertRowid,
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

  let imported = 0;
  let skipped = 0;

  try {
    if (all) {
      // Batch mode: input is { "Group Name": { ...collectionCard }, ... }
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

        const warnings = validateCollectionCard(classification);
        if (warnings.length > 0) {
          console.error(`  Warning: skipping "${groupName}": ${warnings.join("; ")}`);
          skipped++;
          continue;
        }

        for (const group of matchingGroups) {
          storeCollectionCard(db, group.id, classification, {
            author,
            generatedBy: "manual",
            modelVersion: null,
            lastGeneratedAt: null,
            lastReviewedAt: new Date().toISOString(),
          });
          imported++;
          const keyphrases = normalizeStringArray((classification as any).keyphrases);
          console.error(`  [${group.source}] ${groupName} → ${keyphrases.slice(0, 5).join(", ")}`);
        }
      }
    } else {
      // Single mode: input is { ...collectionCard }
      const group = resolveGroup(db, name!, "id, name, source");

      if (!group) {
        console.error(`Group "${name}" not found in index.`);
        process.exit(1);
      }

      const warnings = validateCollectionCard(input);
      if (warnings.length > 0) {
        console.error(`Invalid Collection Card: ${warnings.join("; ")}`);
        process.exit(1);
      }

      storeCollectionCard(db, group.id, input, {
        author,
        generatedBy: "manual",
        modelVersion: null,
        lastGeneratedAt: null,
        lastReviewedAt: new Date().toISOString(),
      });
      imported++;
      console.error(`  ${group.name} → ${normalizeStringArray(input.keyphrases).slice(0, 5).join(", ")}`);
    }

    console.error(`Imported ${imported} Collection Card(s)${skipped > 0 ? `, skipped ${skipped}` : ""}.`);
  } finally {
    db.close();
  }
}

// ─── ENRICH Command ─────────────────────────────────────────────────────────

async function cmdEnrich() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index enrich — Build retrieval signals and representations

Usage: bookmark-index enrich <group-name> [--verbose]
       bookmark-index enrich --all [--verbose]

Builds per-item signal packs, keyphrases, entities, embeddings, and
collection-level centroid/exemplar representations used by card-match.`);
    process.exit(0);
  }

  const all = flags.has("--all");
  const name = positional[0];
  if (!all && !name) {
    console.error("Usage: bookmark-index enrich <group-name> or --all");
    process.exit(1);
  }

  const db = openDb();
  try {
    const config = loadConfig();
    const now = new Date().toISOString();
    const reviewLookbackSince = isoLookback(config.review.lookback_days);
    const groups = all
      ? (db.prepare(`SELECT id, name, source FROM groups ORDER BY id`).all() as any[])
      : (() => {
          const group = resolveGroup(db, name!, "id, name, source");
          if (!group) {
            console.error(`Group "${name}" not found in index.`);
            process.exit(1);
          }
          return [group];
        })();

    const getItems = db.prepare(
      `SELECT id, title, url FROM items WHERE group_id = ? ORDER BY id`
    );
    const updateItem = db.prepare(`
      UPDATE items SET
        normalized_url = ?,
        signal_pack_text = ?,
        embedding_vector = ?,
        embedding_model_version = ?,
        extracted_keyphrases = ?,
        extracted_entities = ?,
        signals_updated_at = ?
      WHERE id = ?
    `);
    const upsertRepresentation = db.prepare(`
      INSERT INTO collection_representations (
        group_id, centroid_vector, exemplar_vectors, embedding_model_version, source_item_count,
        keyword_signature, entity_signature, last_drift_score, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        centroid_vector = excluded.centroid_vector,
        exemplar_vectors = excluded.exemplar_vectors,
        embedding_model_version = excluded.embedding_model_version,
        source_item_count = excluded.source_item_count,
        keyword_signature = excluded.keyword_signature,
        entity_signature = excluded.entity_signature,
        last_drift_score = excluded.last_drift_score,
        updated_at = excluded.updated_at
    `);
    const deleteRepresentation = db.prepare(
      `DELETE FROM collection_representations WHERE group_id = ?`
    );
    const getRepresentation = db.prepare(
      `SELECT centroid_vector, keyword_signature
       FROM collection_representations
       WHERE group_id = ?`
    );
    const getFeedbackStats = db.prepare(`
      SELECT COUNT(*) AS total_feedback,
             SUM(CASE WHEN feedback_type IN ('wrong_match','missing_match') THEN 1 ELSE 0 END) AS confusion_count
      FROM match_feedback
      WHERE expected_group = ? AND created_at >= ?
    `);
    const getMatchStats = db.prepare(`
      SELECT COUNT(*) AS total_matches,
             SUM(CASE WHEN is_ambiguous = 1 THEN 1 ELSE 0 END) AS ambiguous_count
      FROM match_log
      WHERE top_match_group = ? AND created_at >= ?
    `);
    const upsertReviewQueue = db.prepare(`
      INSERT INTO collection_review_queue (
        group_id, status, priority, reasons_json, drift_score, confusion_count, ambiguity_rate,
        queued_at, updated_at, reviewed_at, reviewed_version, resolution_notes
      )
      VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(group_id) DO UPDATE SET
        status = 'open',
        priority = excluded.priority,
        reasons_json = excluded.reasons_json,
        drift_score = excluded.drift_score,
        confusion_count = excluded.confusion_count,
        ambiguity_rate = excluded.ambiguity_rate,
        updated_at = excluded.updated_at,
        reviewed_at = NULL,
        reviewed_version = NULL,
        resolution_notes = NULL
    `);

    let enrichedGroups = 0;
    let enrichedItems = 0;
    let queuedForReview = 0;

    for (const group of groups) {
      const items = getItems.all(group.id) as { id: number; title: string; url: string }[];
      const vectors: number[][] = [];
      const keywordCounts = new Map<string, number>();
      const entityCounts = new Map<string, number>();
      const itemSignals = items.map((item) => ({
        item,
        signals: extractItemSignals(
          item.title,
          item.url,
          config.enrich.max_keyphrases_per_item,
          config.enrich.max_entities_per_item
        ),
      }));

      const embeddings = await embedTextsWithConfig(
        itemSignals.map(({ signals }) => signals.signalPackText),
        config.enrich
      );

      for (let index = 0; index < itemSignals.length; index++) {
        const { item, signals } = itemSignals[index];
        const embedding = embeddings[index];

        updateItem.run(
          signals.normalizedUrl,
          signals.signalPackText,
          serializeVector(embedding),
          config.enrich.embedding_model_version,
          JSON.stringify(signals.keyphrases),
          JSON.stringify(signals.entities),
          now,
          item.id
        );

        vectors.push(embedding);
        for (const keyword of signals.keyphrases) {
          keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
        }
        for (const entity of signals.entities) {
          entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
        }
        enrichedItems++;
      }

      if (vectors.length === 0) {
        deleteRepresentation.run(group.id);
        if (verbose) {
          log(`Cleared representation for "${group.name}" (no items)`);
        }
        continue;
      }

      const previousRepresentation = getRepresentation.get(group.id) as {
        centroid_vector: string | null;
        keyword_signature: string | null;
      } | null;
      const centroid = meanVector(vectors);
      const exemplars = selectExemplars(
        vectors,
        centroid,
        config.enrich.max_exemplars
      );
      const keywordSignature = summarizeTopTerms(keywordCounts, 12);
      const entitySignature = summarizeTopTerms(entityCounts, 12);
      const previousCentroid = parseVector(previousRepresentation?.centroid_vector);
      const previousCentroidSimilarity =
        previousCentroid && previousCentroid.length === centroid.length
          ? dotProduct(previousCentroid, centroid)
          : null;
      const feedbackStats = getFeedbackStats.get(
        group.name,
        reviewLookbackSince
      ) as { total_feedback: number | null; confusion_count: number | null };
      const matchStats = getMatchStats.get(
        group.name,
        reviewLookbackSince
      ) as { total_matches: number | null; ambiguous_count: number | null };
      const ambiguityRate =
        (matchStats.total_matches || 0) > 0
          ? (matchStats.ambiguous_count || 0) / (matchStats.total_matches || 1)
          : 0;
      const drift = evaluateCollectionDrift({
        previousCentroidSimilarity,
        previousKeywords: parseSignature(previousRepresentation?.keyword_signature),
        nextKeywords: keywordSignature,
        confusionCount: feedbackStats.confusion_count || 0,
        feedbackCount: feedbackStats.total_feedback || 0,
        ambiguityRate,
        driftThreshold: config.review.drift_threshold,
        centroidShiftThreshold: config.review.centroid_shift_threshold,
        keywordShiftThreshold: config.review.keyword_shift_threshold,
        confusionThreshold: config.review.confusion_threshold,
        ambiguityThreshold: config.review.ambiguity_threshold,
      });

      upsertRepresentation.run(
        group.id,
        serializeVector(centroid),
        JSON.stringify(exemplars),
        config.enrich.embedding_model_version,
        vectors.length,
        JSON.stringify(keywordSignature),
        JSON.stringify(entitySignature),
        drift.score,
        now
      );

      if (drift.shouldQueue) {
        upsertReviewQueue.run(
          group.id,
          Math.max(drift.score, drift.confusionRate, drift.ambiguityRate),
          JSON.stringify(drift.reasons),
          drift.score,
          feedbackStats.confusion_count || 0,
          ambiguityRate,
          now,
          now
        );
        queuedForReview++;
        if (verbose) {
          log(
            `Queued review: "${group.name}" (${drift.reasons.join(", ") || `score ${drift.score.toFixed(3)}`})`
          );
        }
      }

      enrichedGroups++;
      console.error(
        `Enriched: [${group.source}] ${group.name} (${vectors.length} items, ${exemplars.length} exemplars, drift ${drift.score.toFixed(2)})`
      );
    }

    console.error(
      `Enriched ${enrichedGroups} group(s) and ${enrichedItems} item(s) using ${config.enrich.embedding_model_version}; queued ${queuedForReview} group(s) for review.`
    );
  } finally {
    db.close();
  }
}

// ─── MATCH Command ───────────────────────────────────────────────────────────

async function cmdMatch() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index match — Find matching groups for a URL

Usage: bookmark-index match <url> [hint] [--json] [--top N] [--no-prescore] [--no-cache] [--strategy NAME] [--verbose]
       bookmark-index match --feedback <url> --expected <group> [--type wrong_match|missing_match|correct|note] [--notes "..."]
       bookmark-index match --audit [--json] [--has-feedback] [--wrong-only]
       bookmark-index match --diagnose <url> [--json]

Fetches the URL and matches it against stored Collection Cards.
The default card-match strategy uses vector scoring when enrichment
data is available, with lexical fallback when it is not.
The llm-fetch strategy remains available as a secondary option.

An optional hint (e.g. "sandbox") skips the cache and boosts groups
whose Collection Cards match the hint term. This helps
bridge semantic gaps that keyword matching alone cannot handle.

Options:
  --no-prescore   Skip local pre-scoring (use arbitrary group order)
  --no-cache      Skip the match cache and force a fresh match
  --top N         Show top N matches (default: 10)
  --strategy NAME Match strategy to use (default: card-match)
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
  const topN = parseInt(flagValues["--top"] || "10", 10);
  const noPrescore = flags.has("--no-prescore");
  const noCache = flags.has("--no-cache") || !!hint;
  const strategyName = flagValues["--strategy"] || "card-match";

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

    // Load Collection Cards (via active version)
    log("Loading Collection Cards from index...");
    const groups = db
      .prepare(
        `SELECT g.id, g.source, g.name, g.last_active,
                c.definition, c.includes_json, c.excludes_json, c.keyphrases_json, c.representative_entities_json,
                cr.centroid_vector, cr.exemplar_vectors, cr.embedding_model_version as representation_model_version
         FROM groups g
         JOIN group_classifications c ON g.active_version = c.id
         LEFT JOIN collection_representations cr ON cr.group_id = g.id
         WHERE g.active_version IS NOT NULL`
      )
      .all() as any[];

    if (groups.length === 0) {
      console.error("No Collection Cards found. Run: bookmark-index classify --all");
      process.exit(1);
    }
    log(`Loaded ${groups.length} Collection Card(s)`);

    const apiKey = strategy.name === "llm-fetch" ? resolveApiKey(config.openrouter) : "";
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
      INSERT INTO match_log (url, created_at, page_signal_excerpt, page_keyphrases,
        candidate_count, candidates_sent, candidate_ids, prescore_cutoff, strategy_name,
        model, raw_response, match_results, top_match_group, top_match_score,
        top1_margin, topk_entropy, is_ambiguous)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      url,
      new Date().toISOString(),
      result.pageSignalExcerpt,
      JSON.stringify(result.pageKeyphrases),
      result.candidateCount,
      result.candidatesSent,
      JSON.stringify(result.candidateIds),
      result.prescoreCutoff,
      strategy.name,
      result.model,
      result.rawResponse,
      JSON.stringify(topMatches),
      topMatches[0]?.group || null,
      topMatches[0]?.score ?? null,
      result.top1Margin,
      result.topKEntropy,
      result.isAmbiguous ? 1 : 0,
    );

    printMatchResult(result.classification, topMatches);
  } finally {
    db.close();
  }
}

function printMatchResult(classification: null, matches: any[]) {
  if (jsonMode) {
    console.log(JSON.stringify({ classification, matches }, null, 2));
  } else {
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
    const logEntry = db
      .prepare(`SELECT * FROM match_log WHERE url = ? ORDER BY created_at DESC LIMIT 1`)
      .get(url) as any;

    if (!logEntry) {
      console.error(`No match history for "${url}". Run: bookmark-index match ${url}`);
      process.exit(1);
    }

    const feedback = db
      .prepare(`SELECT * FROM match_feedback WHERE url = ? ORDER BY created_at DESC`)
      .all(url) as any[];

    const candidateIds: number[] = logEntry.candidate_ids ? JSON.parse(logEntry.candidate_ids) : [];
    const matchResults = logEntry.match_results ? JSON.parse(logEntry.match_results) : [];
    const pageKeyphrases = parseJsonStringArray(logEntry.page_keyphrases);

    const diagnosis: any = {
      url,
      match_date: logEntry.created_at,
      page_signal_excerpt: logEntry.page_signal_excerpt,
      page_keyphrases: pageKeyphrases,
      candidate_stats: {
        total_ranked: logEntry.candidate_count,
        sent_to_matcher: logEntry.candidates_sent,
        prescore_cutoff: logEntry.prescore_cutoff,
        strategy_name: logEntry.strategy_name,
        top1_margin: logEntry.top1_margin,
        topk_entropy: logEntry.topk_entropy,
        is_ambiguous: !!logEntry.is_ambiguous,
      },
      top_matches: matchResults.slice(0, 5),
      feedback: feedback.map((entry: any) => ({
        type: entry.feedback_type,
        expected_group: entry.expected_group,
        expected_source: entry.expected_source,
        notes: entry.notes,
        date: entry.created_at,
      })),
    };

    function buildFallbackSignals(): CardPageSignals {
      let hostname = "";
      let pathSegments: string[] = [];
      try {
        const parsed = new URL(url);
        hostname = parsed.hostname.replace(/^www\./, "");
        pathSegments = parsed.pathname
          .split("/")
          .filter((segment) => segment.length > 1)
          .map((segment) => segment.toLowerCase().replace(/[^a-z0-9-]/g, ""));
      } catch {}

      return {
        hostname,
        pathSegments,
        title: "",
        headings: [],
        excerpt: logEntry.page_signal_excerpt || "",
        text: (logEntry.page_signal_excerpt || "").toLowerCase(),
        keywords: new Set(pageKeyphrases),
      };
    }

    for (const entry of feedback) {
      if (!entry.expected_group) continue;

      const expectedGroup = db
        .prepare(
          `SELECT g.id, g.source, g.name, g.last_active,
                  c.definition, c.includes_json, c.excludes_json, c.keyphrases_json, c.representative_entities_json
           FROM groups g
           JOIN group_classifications c ON g.active_version = c.id
           WHERE g.name = ?
           ORDER BY CASE WHEN g.source = 'safari' THEN 0 ELSE 1 END`
        )
        .get(entry.expected_group) as any;

      if (!expectedGroup) {
        diagnosis[`diagnosis_${entry.expected_group}`] = { error: "Group not found in index" };
        continue;
      }

      const wasInCandidateSet = candidateIds.includes(expectedGroup.id);
      const wasInMatches = matchResults.some(
        (match: any) => match.group === expectedGroup.name && match.source === expectedGroup.source
      );

      const groups = db
        .prepare(
          `SELECT g.id, g.source, g.name, g.last_active,
                  c.definition, c.includes_json, c.excludes_json, c.keyphrases_json, c.representative_entities_json
           FROM groups g
           JOIN group_classifications c ON g.active_version = c.id
           WHERE g.active_version IS NOT NULL`
        )
        .all() as any[];

      let pageSignals: CardPageSignals = buildFallbackSignals();
      let groupRank = -1;
      let groupPrescore = 0;

      try {
        try {
          const pageText = await fetchAndConvertToMarkdown(url, fetch);
          pageSignals = extractCardPageSignals(url, pageText, loadConfig().match.max_page_bytes);
        } catch {
          pageSignals = buildFallbackSignals();
        }

        const domainGroupIds = new Set(
          (
            db.prepare(`SELECT DISTINCT group_id FROM items WHERE url LIKE '%' || ? || '%'`).all(
              pageSignals.hostname
            ) as { group_id: number }[]
          ).map((row) => row.group_id)
        );

        const scored = scoreCollectionCardCandidates(groups, pageSignals, domainGroupIds);
        scored.sort((a, b) => b.localScore - a.localScore);

        const groupEntry = scored.find((candidate) => candidate.group.id === expectedGroup.id);
        if (groupEntry) {
          groupPrescore = groupEntry.localScore;
          groupRank = scored.indexOf(groupEntry) + 1;
        }
      } catch {}

      const expectedCard = parseCollectionCard(expectedGroup);
      const keyphraseOverlap = expectedCard.keyphrases.filter((phrase) =>
        pageKeyphrases.some(
          (token) => phrase === token || phrase.includes(token) || token.includes(phrase)
        )
      );

      let rootCause: string;
      if (!wasInCandidateSet) {
        rootCause = `CANDIDATE_SELECTION: Group was not in the candidate set (rank ${groupRank}/${groups.length}, pre-score ${groupPrescore.toFixed(3)}, cutoff was ${logEntry.prescore_cutoff?.toFixed(3) || "?"})`;
      } else if (!wasInMatches) {
        rootCause =
          logEntry.strategy_name === "llm-fetch"
            ? "LLM_RANKING: Group was in the candidate set but the LLM did not select it as a match"
            : "MATCHING: Group was in the candidate set but not returned as a final match";
      } else {
        const matchEntry = matchResults.find((match: any) => match.group === expectedGroup.name);
        rootCause = `MATCH_SCORE: Group was matched but scored ${matchEntry?.score?.toFixed(2) || "?"}`;
      }

      diagnosis[`diagnosis_${entry.expected_group}`] = {
        expected_group: {
          id: expectedGroup.id,
          source: expectedGroup.source,
          name: expectedGroup.name,
          definition: expectedCard.definition,
          keyphrases: expectedCard.keyphrases,
        },
        was_in_candidate_set: wasInCandidateSet,
        was_in_final_matches: wasInMatches,
        prescore_rank: groupRank,
        prescore_value: groupPrescore,
        keyphrase_overlap_with_page: keyphraseOverlap,
        root_cause: rootCause,
      };
    }

    if (jsonMode) {
      console.log(JSON.stringify(diagnosis, null, 2));
    } else {
      console.log(`Diagnosis for: ${url}`);
      console.log(`Matched: ${logEntry.created_at}`);
      console.log(`Strategy: ${logEntry.strategy_name || "unknown"}`);
      console.log(`Model: ${logEntry.model}`);
      console.log();
      console.log(`Page signal excerpt: ${logEntry.page_signal_excerpt || "-"}`);
      console.log(`Page keyphrases: ${pageKeyphrases.join(", ") || "-"}`);
      console.log();
      console.log(
        `Candidates: ${logEntry.candidates_sent} of ${logEntry.candidate_count} groups (cutoff: ${logEntry.prescore_cutoff?.toFixed(3) || "?"})`
      );
      console.log(
        `Ambiguity: margin=${logEntry.top1_margin?.toFixed?.(3) ?? "?"} entropy=${logEntry.topk_entropy?.toFixed?.(3) ?? "?"} flag=${logEntry.is_ambiguous ? "YES" : "NO"}`
      );
      console.log();

      if (matchResults.length > 0) {
        console.log("Top matches:");
        for (const match of matchResults.slice(0, 5)) {
          console.log(`  ${match.score?.toFixed(2) || "?"}  [${match.source}] ${match.group}`);
        }
        console.log();
      }

      if (feedback.length === 0) {
        console.log("No feedback recorded for this URL.");
        console.log(`Record feedback: bookmark-index match --feedback ${url} --expected "Group Name"`);
      } else {
        for (const entry of feedback) {
          console.log(`Feedback (${entry.feedback_type}): expected "${entry.expected_group}"`);
          if (entry.notes) console.log(`  Notes: ${entry.notes}`);

          const diag = diagnosis[`diagnosis_${entry.expected_group}`];
          if (diag && !diag.error) {
            console.log(`  Expected group: [${diag.expected_group.source}] ${diag.expected_group.name}`);
            console.log(`    Keyphrases: ${JSON.stringify(diag.expected_group.keyphrases)}`);
            console.log(
              `    In candidate set: ${diag.was_in_candidate_set ? "YES" : "NO"} (rank ${diag.prescore_rank}, pre-score ${diag.prescore_value.toFixed(3)})`
            );
            console.log(`    In final matches: ${diag.was_in_final_matches ? "YES" : "NO"}`);
            console.log(
              `    Keyphrase overlap with page: ${JSON.stringify(diag.keyphrase_overlap_with_page)}`
            );
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
    console.error("Usage: bookmark-index version <group-name> [set <number> | copy]");
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
      `SELECT id, version, generated_by, author, created_at
       FROM group_classifications WHERE group_id = ? ORDER BY version`
    ).all(group.id) as { id: number; version: number; generated_by: string; author: string; created_at: string }[];

    if (subcommand === "set") {
      const versionNum = positional[2] ? parseInt(positional[2], 10) : NaN;
      if (isNaN(versionNum)) {
        console.error("Usage: bookmark-index version <group-name> set <number>");
        process.exit(1);
      }

      if (versions.length === 0) {
        console.error(`No Collection Card versions for "${group.name}".`);
        process.exit(1);
      }

      const target = versions.find(v => v.version === versionNum);
      if (!target) {
        console.error(`Version ${versionNum} not found. Available: ${versions.map(v => v.version).join(", ")}`);
        process.exit(1);
      }

      db.prepare(`UPDATE groups SET active_version = ? WHERE id = ?`).run(target.id, group.id);

      console.log(`Set active version to v${versionNum} for "${group.name}"`);
    } else if (subcommand === "copy") {
      if (!group.active_version) {
        console.error(`No active Collection Card to copy for "${group.name}".`);
        process.exit(1);
      }

      const active = db.prepare(`SELECT * FROM group_classifications WHERE id = ?`).get(group.active_version) as any;
      const maxVer = db.prepare(
        `SELECT COALESCE(MAX(version), 0) as max_ver FROM group_classifications WHERE group_id = ?`
      ).get(group.id) as { max_ver: number };
      const nextVersion = maxVer.max_ver + 1;
      const now = new Date().toISOString();
      const author = flagValues["--author"] || `copy of v${active.version}`;

      db.prepare(`
        INSERT INTO group_classifications (
          group_id, version, definition, includes_json, excludes_json, keyphrases_json,
          representative_entities_json, generated_by, model_version, last_generated_at,
          last_reviewed_at, author, created_at, card_schema_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        group.id,
        nextVersion,
        active.definition,
        active.includes_json,
        active.excludes_json,
        active.keyphrases_json,
        active.representative_entities_json,
        "manual",
        null,
        null,
        now,
        author,
        now,
        active.card_schema_version ?? 1
      );

      console.log(`Created v${nextVersion} for "${group.name}" (copied from v${active.version}, not yet active)`);
    } else if (subcommand === null) {
      if (versions.length === 0) {
        console.error(`No Collection Card versions for "${group.name}".`);
        process.exit(1);
      }

      console.log(`Versions for "${group.name}" [${group.source}]:`);
      for (const v of versions) {
        const active = group.active_version === v.id ? "  \u2190 active" : "";
        const date = v.created_at ? v.created_at.slice(0, 10) : "unknown";
        console.log(`  v${v.version}  ${v.generated_by || "-"}  ${v.author || "-"}  ${date}${active}`);
      }
    } else {
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error("Usage: bookmark-index version <group-name> [set <number> | copy]");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ─── REVIEW Command ──────────────────────────────────────────────────────────

function cmdReview() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index review — Inspect and resolve review queue items

Usage: bookmark-index review list [--json]
       bookmark-index review show <group-name> [--json]
       bookmark-index review diff <group-name> [version]
       bookmark-index review approve <group-name> [version] [--notes "..."]

Lists drift-queued collections, shows queue context, diffs Collection Card
versions, and marks a collection as reviewed.`);
    process.exit(0);
  }

  const subcommand = positional[0] || "list";
  const db = openDb();
  try {
    if (subcommand === "list") {
      const rows = db.prepare(`
        SELECT g.name, g.source, crq.priority, crq.drift_score, crq.confusion_count,
               crq.ambiguity_rate, crq.reasons_json, crq.queued_at, crq.updated_at
        FROM collection_review_queue crq
        JOIN groups g ON g.id = crq.group_id
        WHERE crq.status = 'open'
        ORDER BY crq.priority DESC, crq.updated_at DESC
      `).all() as any[];

      if (jsonMode) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No open review items.");
        return;
      }

      console.log("Open review items:");
      for (const row of rows) {
        const reasons = parseSignature(row.reasons_json);
        console.log(
          `  ${row.priority.toFixed(2)}  [${row.source}] ${row.name}  drift=${row.drift_score.toFixed(2)}  ambiguity=${row.ambiguity_rate.toFixed(2)}`
        );
        if (reasons.length > 0) {
          console.log(`         ${reasons.join("; ")}`);
        }
      }
      return;
    }

    const groupName = positional[1];
    if (!groupName) {
      console.error(`Usage: bookmark-index review ${subcommand} <group-name>`);
      process.exit(1);
    }

    const group = resolveGroup(db, groupName);
    if (!group) {
      console.error(`Group "${groupName}" not found.`);
      process.exit(1);
    }

    if (subcommand === "show") {
      const queue = db.prepare(`
        SELECT status, priority, reasons_json, drift_score, confusion_count,
               ambiguity_rate, queued_at, updated_at, reviewed_at, reviewed_version, resolution_notes
        FROM collection_review_queue
        WHERE group_id = ?
      `).get(group.id) as any | null;
      const active = group.active_version
        ? (db.prepare(`SELECT * FROM group_classifications WHERE id = ?`).get(group.active_version) as any)
        : null;
      const latest = db.prepare(`
        SELECT * FROM group_classifications
        WHERE group_id = ?
        ORDER BY version DESC
        LIMIT 1
      `).get(group.id) as any | null;

      const payload = {
        group: {
          name: group.name,
          source: group.source,
          active_version: active?.version || null,
          latest_version: latest?.version || null,
        },
        review: queue,
        card: active ? parseCollectionCard(active) : null,
      };

      if (jsonMode) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`[${group.source}] ${group.name}`);
      if (!queue) {
        console.log("No review queue entry.");
      } else {
        console.log(
          `Queue: ${queue.status}  priority=${queue.priority.toFixed(2)}  drift=${queue.drift_score.toFixed(2)}`
        );
        const reasons = parseSignature(queue.reasons_json);
        console.log(`Reasons: ${reasons.join("; ") || "-"}`);
        console.log(
          `Confusion=${queue.confusion_count}  Ambiguity=${queue.ambiguity_rate.toFixed(2)}  Queued=${queue.queued_at}`
        );
        if (queue.reviewed_at) {
          console.log(`Last reviewed: ${queue.reviewed_at} (version ${queue.reviewed_version || "?"})`);
        }
        if (queue.resolution_notes) {
          console.log(`Resolution notes: ${queue.resolution_notes}`);
        }
      }

      if (active) {
        console.log();
        console.log(`Active version: v${active.version} (${active.generated_by})`);
        console.log(`Last reviewed at: ${active.last_reviewed_at || "-"}`);
        console.log(`Keyphrases: ${parseCollectionCard(active).keyphrases.join(", ") || "-"}`);
      }
      return;
    }

    if (subcommand === "diff") {
      if (!group.active_version) {
        console.error(`No active Collection Card for "${group.name}".`);
        process.exit(1);
      }

      const active = db.prepare(`SELECT * FROM group_classifications WHERE id = ?`).get(group.active_version) as any;
      const requestedVersion = positional[2] ? parseInt(positional[2], 10) : NaN;
      const target =
        !Number.isNaN(requestedVersion)
          ? (db.prepare(`
              SELECT * FROM group_classifications
              WHERE group_id = ? AND version = ?
            `).get(group.id, requestedVersion) as any | null)
          : (db.prepare(`
              SELECT * FROM group_classifications
              WHERE group_id = ? AND id != ?
              ORDER BY version DESC
              LIMIT 1
            `).get(group.id, group.active_version) as any | null);

      if (!target) {
        console.error(`No comparison version found for "${group.name}".`);
        process.exit(1);
      }

      const diffs = diffCollectionCards(active, target);
      if (jsonMode) {
        console.log(JSON.stringify({
          group: group.name,
          active_version: active.version,
          compare_version: target.version,
          diffs,
        }, null, 2));
        return;
      }

      console.log(`Diff for "${group.name}": v${active.version} -> v${target.version}`);
      if (diffs.length === 0) {
        console.log("No field changes.");
        return;
      }

      for (const diff of diffs) {
        if (Array.isArray(diff.before) && Array.isArray(diff.after)) {
          console.log(`  ${diff.field}:`);
          console.log(`    - ${diff.before.join(", ") || "-"}`);
          console.log(`    + ${diff.after.join(", ") || "-"}`);
        } else {
          console.log(`  ${diff.field}:`);
          console.log(`    - ${String(diff.before || "-")}`);
          console.log(`    + ${String(diff.after || "-")}`);
        }
      }
      return;
    }

    if (subcommand === "approve") {
      const requestedVersion = positional[2] ? parseInt(positional[2], 10) : NaN;
      const target =
        !Number.isNaN(requestedVersion)
          ? (db.prepare(`
              SELECT id, version FROM group_classifications
              WHERE group_id = ? AND version = ?
            `).get(group.id, requestedVersion) as { id: number; version: number } | null)
          : group.active_version
            ? ({ id: group.active_version, version: (db.prepare(`
                SELECT version FROM group_classifications WHERE id = ?
              `).get(group.active_version) as { version: number }).version })
            : null;

      if (!target) {
        console.error(`No Collection Card version available to approve for "${group.name}".`);
        process.exit(1);
      }

      const now = new Date().toISOString();
      if (group.active_version !== target.id) {
        db.prepare(`UPDATE groups SET active_version = ?, updated_at = ? WHERE id = ?`).run(
          target.id,
          now,
          group.id
        );
      }
      db.prepare(`UPDATE group_classifications SET last_reviewed_at = ? WHERE id = ?`).run(
        now,
        target.id
      );
      db.prepare(`
        INSERT INTO collection_review_queue (
          group_id, status, priority, reasons_json, drift_score, confusion_count, ambiguity_rate,
          queued_at, updated_at, reviewed_at, reviewed_version, resolution_notes
        )
        VALUES (?, 'approved', 0, '[]', 0, 0, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          status = 'approved',
          updated_at = excluded.updated_at,
          reviewed_at = excluded.reviewed_at,
          reviewed_version = excluded.reviewed_version,
          resolution_notes = excluded.resolution_notes
      `).run(
        group.id,
        now,
        now,
        now,
        target.version,
        flagValues["--notes"] || null
      );

      console.log(
        `Reviewed "${group.name}" using v${target.version}${group.active_version === target.id ? "" : " (now active)"}.`
      );
      return;
    }

    console.error(`Unknown review subcommand: ${subcommand}`);
    console.error("Usage: bookmark-index review [list|show|diff|approve] ...");
    process.exit(1);
  } finally {
    db.close();
  }
}

// ─── METRICS Command ─────────────────────────────────────────────────────────

function cmdMetrics() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index metrics — Report match quality and drift metrics

Usage: bookmark-index metrics [--json] [--days N]

Summarizes accuracy, recall, ambiguity, overrides, and review queue pressure.`);
    process.exit(0);
  }

  const db = openDb();
  try {
    const config = loadConfig();
    const days = Math.max(1, parseInt(flagValues["--days"] || String(config.review.lookback_days), 10));
    const since = isoLookback(days);

    const feedbackRows = db.prepare(`
      SELECT ml.top_match_group, ml.match_results, mf.expected_group, mf.feedback_type
      FROM match_feedback mf
      LEFT JOIN match_log ml ON ml.id = mf.match_log_id
      WHERE mf.created_at >= ?
        AND mf.expected_group IS NOT NULL
        AND mf.feedback_type IN ('wrong_match','missing_match','correct')
      ORDER BY mf.created_at DESC
    `).all(since) as {
      top_match_group: string | null;
      match_results: string | null;
      expected_group: string | null;
      feedback_type: string;
    }[];
    const metricRows = feedbackRows.map((row) => ({
      top_match_group: row.top_match_group,
      expected_group: row.expected_group,
      feedback_type: row.feedback_type,
      match_groups: parseMatchGroupNames(row.match_results),
    }));

    const matchStats = db.prepare(`
      SELECT COUNT(*) AS total_matches,
             SUM(CASE WHEN is_ambiguous = 1 THEN 1 ELSE 0 END) AS ambiguous_matches
      FROM match_log
      WHERE created_at >= ?
    `).get(since) as { total_matches: number | null; ambiguous_matches: number | null };
    const openReviewCount = (
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM collection_review_queue
        WHERE status = 'open'
      `).get() as { total: number }
    ).total;
    const totalGroups = (
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM groups
        WHERE active_version IS NOT NULL
      `).get() as { total: number }
    ).total;

    const summary = summarizeMetrics(
      metricRows,
      matchStats.total_matches || 0,
      matchStats.ambiguous_matches || 0,
      openReviewCount,
      totalGroups
    );

    if (jsonMode) {
      console.log(JSON.stringify({ days, since, ...summary }, null, 2));
      return;
    }

    console.log(`Metrics window: last ${days} day(s)`);
    console.log(`Evaluated feedback: ${summary.evaluatedCount}`);
    console.log(`Top-1 accuracy: ${formatRatio(summary.top1Accuracy)}`);
    console.log(`Top-5 recall: ${formatRatio(summary.top5Recall)}`);
    console.log(`Ambiguity rate: ${formatRatio(summary.ambiguityRate)}`);
    console.log(`Override rate: ${formatRatio(summary.overrideRate)}`);
    console.log(
      `Drift frequency: ${formatRatio(summary.driftFrequency)} (${summary.openReviewCount} open / ${summary.totalGroups} carded groups)`
    );
  } finally {
    db.close();
  }
}

// ─── STATS Command ───────────────────────────────────────────────────────────

function cmdStats() {
  if (flags.has("--help") || flags.has("-h")) {
    console.log(`bookmark-index stats — Show database path, group counts, and cache freshness

Usage: bookmark-index stats [--json] [--db <path>]

Displays database location, group counts by source, and cache file freshness.`);
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
              SUM(CASE WHEN g.active_version IS NOT NULL THEN 1 ELSE 0 END) as carded,
              (SELECT COUNT(*) FROM items i JOIN groups g2 ON i.group_id = g2.id WHERE g2.source = g.source) as urls
       FROM groups g GROUP BY g.source`
    ).all() as { source: string; total: number; carded: number; urls: number }[];

    const groups: Record<string, { total: number; carded: number; urls: number }> = {};
    let grandTotal = 0;
    let grandCarded = 0;
    let grandUrls = 0;
    for (const r of rows) {
      groups[r.source] = { total: r.total, carded: r.carded, urls: r.urls };
      grandTotal += r.total;
      grandCarded += r.carded;
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
        console.log(`  ${s.padEnd(pad)}  ${String(g.total).padStart(3)} groups (${g.carded} with cards), ${g.urls} urls`);
      }
      console.log(`  ${"total".padEnd(pad)}  ${String(grandTotal).padStart(3)} groups (${grandCarded} with cards), ${grandUrls} urls`);
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
  case "enrich":
    await cmdEnrich();
    break;
  case "match":
    await cmdMatch();
    break;
  case "review":
    cmdReview();
    break;
  case "metrics":
    cmdMetrics();
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
