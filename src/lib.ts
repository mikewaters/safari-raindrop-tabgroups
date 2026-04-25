import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { resolveConfigPath } from "./config.ts";
import "./match/claude";
import { getStrategy } from "./match/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchConfig {
  system_prompt: string;
  max_groups_in_prompt: number;
  max_page_bytes: number;
  cache_ttl_minutes: number;
  log_llm_io: boolean;
}

export interface OpenRouterConfig {
  api_key: string;
  model: string;
  system_prompt: string;
  max_content_bytes: number;
  max_tokens?: number;
}

export interface DescribeConfig {
  categories: string[];
  system_prompt: string;
}

export interface ApiConfig {
  token: string;
  port: number;
}

export interface Config {
  openrouter: OpenRouterConfig;
  match: MatchConfig;
  describe: DescribeConfig;
  api?: ApiConfig;
}

// ---------------------------------------------------------------------------
// resolveDbPath
// ---------------------------------------------------------------------------

export function resolveDbPath(dbOverride?: string): string {
  if (dbOverride) return dbOverride;

  const configPath = resolveConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as any;
  let dbPath: string = parsed.database?.path || "$XDG_DATA_HOME/safari-tabgroups/bookmarks.db";

  dbPath = dbPath.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => {
    if (name === "XDG_DATA_HOME") {
      return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    }
    return process.env[name] || "";
  });

  if (dbPath.startsWith("~")) {
    dbPath = join(homedir(), dbPath.slice(1));
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}

// ---------------------------------------------------------------------------
// openDb — full migration logic
// ---------------------------------------------------------------------------

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
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
    CREATE TABLE IF NOT EXISTS highlights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_id     TEXT NOT NULL,
      text          TEXT NOT NULL,
      note          TEXT,
      color         TEXT,
      position      INTEGER,
      created_at    TEXT,
      updated_at    TEXT
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
      llm_input        TEXT,
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
  // Add llm_input column to match_log (idempotent)
  try { db.exec("ALTER TABLE match_log ADD COLUMN llm_input TEXT"); } catch {}
  // Add metadata columns (idempotent)
  try { db.exec("ALTER TABLE groups ADD COLUMN metadata TEXT"); } catch {}
  // Add page_snapshot column to group_classifications (idempotent)
  try { db.exec("ALTER TABLE group_classifications ADD COLUMN page_snapshot TEXT"); } catch {}
  try { db.exec("ALTER TABLE items ADD COLUMN source_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE items ADD COLUMN metadata TEXT"); } catch {}

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
    console.log(`Migrated ${unmigratedGroups.length} inline classification(s) to group_classifications`);
  }

  return db;
}

// ---------------------------------------------------------------------------
// resolveGroup, hash helpers
// ---------------------------------------------------------------------------

export function resolveGroup(db: Database, name: string, columns = "*"): any {
  return db
    .prepare(
      `SELECT ${columns} FROM groups WHERE name = ?
       ORDER BY CASE WHEN source = 'safari' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(name) ?? null;
}

function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function sourceHash(db: Database, source: string): string {
  const rows = db
    .prepare(`SELECT source_id FROM groups WHERE source = ? ORDER BY source_id`)
    .all(source) as { source_id: string }[];
  return sha256Short(rows.map((r) => r.source_id).join("\n"));
}

export function itemsHash(db: Database, groupId: number): string {
  const rows = db
    .prepare(`SELECT url FROM items WHERE group_id = ? ORDER BY url`)
    .all(groupId) as { url: string }[];
  return sha256Short(rows.map((r) => r.url).join("\n"));
}

export function classificationHash(db: Database, groupId: number): string | null {
  const cls = db
    .prepare(
      `SELECT c.category, c.topics, c.description, c.intent, c.confidence
       FROM group_classifications c
       JOIN groups g ON g.active_version = c.id
       WHERE g.id = ?`
    )
    .get(groupId) as { category: string; topics: string; description: string; intent: string; confidence: number } | null;
  if (!cls) return null;
  return sha256Short(
    [cls.category, cls.topics, cls.description, cls.intent, String(cls.confidence)].join("\0")
  );
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

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

export function loadConfig(): Config {
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
      log_llm_io: false,
      ...parsed.match,
    },
    describe: parsed.describe,
    api: parsed.api,
  };
}

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

export function resolveApiKey(config: OpenRouterConfig): string {
  let key = config.api_key;
  if (key.startsWith("$")) {
    key = process.env[key.slice(1)] || "";
  }
  if (!key) {
    throw new Error(
      "OpenRouter API key not set. Configure in config.toml or set the env var."
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// storeClassification
// ---------------------------------------------------------------------------

export function storeClassification(
  db: Database,
  groupId: number,
  result: any,
  author: string = "unknown"
): number {
  const now = new Date().toISOString();
  const topicsJson = result.topics ? JSON.stringify(result.topics) : null;

  const row = db.prepare(
    `SELECT COALESCE(MAX(version), 0) as max_ver FROM group_classifications WHERE group_id = ?`
  ).get(groupId) as { max_ver: number };
  const nextVersion = row.max_ver + 1;

  const info = db.prepare(`
    INSERT INTO group_classifications (group_id, version, description, category, topics, intent, confidence, author, created_at, page_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    nextVersion,
    result.description || null,
    result.category || null,
    topicsJson,
    result.intent || null,
    result.confidence ?? null,
    author,
    now,
    result.page_snapshot || null
  );

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

  return nextVersion;
}

// ---------------------------------------------------------------------------
// executeMatch
// ---------------------------------------------------------------------------

export interface ExecuteMatchParams {
  db: Database;
  config: Config;
  url: string;
  hint?: string | null;
  topN?: number;
  noPrescore?: boolean;
  noCache?: boolean;
  skipFetch?: boolean;
  strategyName?: string;
  verbose?: boolean;
  log?: (...msg: unknown[]) => void;
}

export async function executeMatch(params: ExecuteMatchParams): Promise<{ classification: any; matches: any[] }> {
  const {
    db, config, url,
    hint = null,
    topN = 5,
    noPrescore = false,
    noCache = false,
    skipFetch = false,
    strategyName = "llm-fetch",
    verbose = false,
    log: logFn = () => {},
  } = params;

  const strategy = getStrategy(strategyName);
  logFn(`Using match strategy: ${strategy.name}`);

  // Check cache
  const cacheTtl = noCache ? 0 : (config.match.cache_ttl_minutes ?? 30);

  if (cacheTtl > 0) {
    const cached = db
      .prepare(`SELECT result, cached_at FROM match_cache WHERE url = ?`)
      .get(url) as { result: string; cached_at: string } | null;

    if (cached) {
      const ageMs = Date.now() - new Date(cached.cached_at).getTime();
      if (ageMs < cacheTtl * 60_000) {
        logFn(`Cache hit (age: ${Math.round(ageMs / 1000)}s), returning cached result`);
        return JSON.parse(cached.result);
      }
      logFn(`Cache expired (age: ${Math.round(ageMs / 1000)}s), will re-match`);
    }
  }

  // Load classified groups
  logFn("Loading classified groups from index...");
  const groups = db
    .prepare(
      `SELECT g.id, g.source, g.name, c.category, c.topics, c.description, c.intent, g.last_active
       FROM groups g
       JOIN group_classifications c ON g.active_version = c.id
       WHERE g.active_version IS NOT NULL`
    )
    .all() as any[];

  if (groups.length === 0) {
    throw new Error("No classified groups. Run: bookmark-index classify --all");
  }
  logFn(`Loaded ${groups.length} classified group(s)`);

  const apiKey = resolveApiKey(config.openrouter);

  const result = await strategy.match({
    url,
    hint,
    db,
    config,
    groups,
    topN,
    noPrescore,
    skipFetch,
    verbose,
    log: logFn,
    apiKey,
  });

  const topMatches = result.matches.slice(0, topN);
  logFn(`Returning top ${topMatches.length} of ${result.matches.length} match(es)`);

  // Cache the result
  if (cacheTtl > 0) {
    db.prepare(
      `INSERT OR REPLACE INTO match_cache (url, result, cached_at) VALUES (?, ?, ?)`
    ).run(url, JSON.stringify({ classification: result.classification, matches: topMatches }), new Date().toISOString());
  }

  // Log the match
  db.prepare(`
    INSERT INTO match_log (url, created_at, page_category, page_topics, page_description,
      candidate_count, candidates_sent, candidate_ids, prescore_cutoff, model,
      llm_input, raw_response, match_results, top_match_group, top_match_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    result.llmInput || null,
    result.rawResponse,
    JSON.stringify(topMatches),
    topMatches[0]?.group || null,
    topMatches[0]?.score ?? null,
  );

  return { classification: result.classification, matches: topMatches };
}

// ---------------------------------------------------------------------------
// listCollections / showCollection
// ---------------------------------------------------------------------------

export function listCollections(db: Database, opts: {
  source?: string;
  limit?: number;
  offset?: number;
}): { total: number; offset: number; limit: number | null; source_hashes: Record<string, string>; rows: any[] } {
  let sql = `SELECT g.id, g.source, g.name, g.profile, g.tab_count, g.last_active,
                    COALESCE(c.category, g.category) as category,
                    g.classified_at, g.active_version
             FROM groups g
             LEFT JOIN group_classifications c ON g.active_version = c.id`;
  const conditions: string[] = [];
  if (opts.source === "safari") conditions.push(`g.source = 'safari'`);
  if (opts.source === "raindrop") conditions.push(`g.source = 'raindrop'`);
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;

  const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
  const total = (db.prepare(countSql).get() as { total: number }).total;

  sql += ` ORDER BY g.last_active DESC NULLS LAST`;

  const limit = opts.limit ?? null;
  const offset = opts.offset ?? 0;
  if (limit != null) sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const rows = db.prepare(sql).all() as any[];

  const sources = [...new Set(rows.map((r: any) => r.source))];
  const sourceHashes: Record<string, string> = {};
  for (const s of sources) {
    sourceHashes[s] = sourceHash(db, s);
  }

  const enrichedRows = rows.map((r: any) => ({
    ...r,
    items_hash: itemsHash(db, r.id),
    classification_hash: classificationHash(db, r.id),
  }));

  return { total, offset, limit, source_hashes: sourceHashes, rows: enrichedRows };
}

export function showCollection(db: Database, name: string): any {
  const group = resolveGroup(db, name);

  if (!group) {
    // Try partial match for suggestions
    const matches = db
      .prepare(`SELECT name, source FROM groups WHERE name LIKE ?`)
      .all(`%${name}%`) as any[];
    const suggestions = matches.map((m: any) => `[${m.source}] ${m.name}`);
    const err: any = new Error(`Group "${name}" not found.`);
    err.status = 404;
    err.suggestions = suggestions;
    throw err;
  }

  const items = db
    .prepare(
      `SELECT id, title, url, last_active, created_at, source_id, metadata FROM items WHERE group_id = ? ORDER BY last_active DESC NULLS LAST`
    )
    .all(group.id) as any[];

  const getHighlights = db.prepare(
    `SELECT source_id, text, note, color, position, created_at, updated_at FROM highlights WHERE item_id = ?`
  );
  for (const item of items) {
    const highlights = getHighlights.all(item.id) as any[];
    if (highlights.length > 0) item.highlights = highlights;
    if (item.metadata) {
      try { item.metadata = JSON.parse(item.metadata); } catch {}
    }
  }

  let activeClassification: any = null;
  if (group.active_version) {
    activeClassification = db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM group_classifications WHERE group_id = c.group_id) as total_versions
       FROM group_classifications c WHERE c.id = ?`
    ).get(group.active_version);
  }

  const cls = activeClassification || group;
  const groupMeta = group.metadata ? (() => { try { return JSON.parse(group.metadata); } catch { return group.metadata; } })() : null;

  return {
    ...group,
    metadata: groupMeta,
    topics: cls.topics ? JSON.parse(cls.topics) : null,
    description: cls.description,
    category: cls.category,
    intent: cls.intent,
    confidence: cls.confidence,
    version: activeClassification?.version ?? null,
    total_versions: activeClassification?.total_versions ?? 0,
    author: activeClassification?.author ?? null,
    page_snapshot: activeClassification?.page_snapshot ?? null,
    source_hash: sourceHash(db, group.source),
    items_hash: itemsHash(db, group.id),
    classification_hash: classificationHash(db, group.id),
    items,
  };
}
