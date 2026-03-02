# Database Schema — bookmark-index

The bookmark-index CLI stores all data in a single SQLite database.

## Location

Default: `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db` (typically `~/.local/share/safari-tabgroups/bookmarks.db`)

Override via:
- `--db <path>` CLI flag (highest priority)
- `database.path` in `fetch.config.toml`

## PRAGMA Settings

| Pragma | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | WAL | Concurrent reads during writes; crash recovery |
| `foreign_keys` | ON | Enforce referential integrity (cascade deletes) |

## Tables

### `groups`

Primary table. Each row is a Safari tab group or Raindrop collection.

```sql
CREATE TABLE groups (
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
  topics        TEXT,       -- JSON array, e.g. '["ai","rag"]'
  intent        TEXT,
  confidence    REAL,       -- 0.0–1.0
  classified_at TEXT,
  active_version INTEGER REFERENCES group_classifications(id),
  updated_at    TEXT NOT NULL,
  UNIQUE(source, source_id)
);
```

**Constraints:**
- `source` is either `'safari'` or `'raindrop'`
- `(source, source_id)` is unique — prevents duplicate imports from the same upstream source
- `name` is **not unique** — the same name can appear across sources (e.g. demoting a Safari tab group to a Raindrop collection)

**Name disambiguation:** When multiple groups share a name, `resolveGroup()` prefers Safari via `ORDER BY CASE WHEN source = 'safari' THEN 0 ELSE 1 END`.

**Classification fields:** `description`, `category`, `topics`, `intent`, `confidence`, and `classified_at` are kept as inline fields for backward compatibility. The authoritative classification data lives in `group_classifications` — the inline fields are synced whenever the active version changes.

**`active_version`:** Points to the `group_classifications.id` of the currently selected classification version. When null, the group is unclassified.

---

### `items`

Child table. Each row is a tab or bookmark within a group.

```sql
CREATE TABLE items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  last_active TEXT,
  created_at  TEXT,
  UNIQUE(group_id, url)
);
```

**Constraints:**
- FK to `groups(id)` with `ON DELETE CASCADE` — deleting a group removes all its items
- `(group_id, url)` is unique — no duplicate URLs within a group

**Sync behavior:** On each `update`, all items for a group are deleted and re-inserted (full refresh, not incremental).

---

### `group_classifications`

Stores every classification version for every group. Each `classify` or `classify --import` run creates a new version rather than overwriting the previous one.

```sql
CREATE TABLE IF NOT EXISTS group_classifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  description TEXT,
  category    TEXT,
  topics      TEXT,       -- JSON array
  intent      TEXT,
  confidence  REAL,
  author      TEXT,       -- e.g. "openrouter/google/gemini-2.5-flash", "import", "mike"
  created_at  TEXT NOT NULL,
  UNIQUE(group_id, version)
);
```

**Constraints:**
- FK to `groups(id)` with `ON DELETE CASCADE`
- `(group_id, version)` is unique — versions are sequential per group starting at 1

**Author:** Free-form string indicating provenance. LLM classifications use `openrouter/<model>`, imports default to `"import"` (overridable with `--author`), and migrated inline data uses `"migrated"`.

**Version selection:** The active version for each group is tracked by `groups.active_version`. Use the `version` command to list versions or switch the active one.

---

### `meta`

Key-value store for sync metadata.

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Current keys:**

| Key | Value | Set by |
|-----|-------|--------|
| `last_sync_safari` | ISO timestamp | `update` command |
| `last_sync_raindrop` | ISO timestamp | `update` command |

These are informational — they do not gate sync freshness.

---

### `match_cache`

Caches `match` command results to avoid redundant LLM calls.

```sql
CREATE TABLE match_cache (
  url       TEXT PRIMARY KEY,
  result    TEXT NOT NULL,    -- JSON: { classification, matches }
  cached_at TEXT NOT NULL     -- ISO timestamp
);
```

**TTL:** Configured via `match.cache_ttl_minutes` in `fetch.config.toml` (default: 30 minutes). Set to `0` to disable caching entirely. Expired entries are not auto-deleted; they're ignored on read.

**Result JSON shape:**
```json
{
  "classification": { "category": "...", "topics": [...], "description": "..." },
  "matches": [
    { "group": "Name", "source": "safari", "score": 0.85, "reason": "...", "rawScore": 0.7, "lastActive": "..." }
  ]
}
```

### `match_log`

Audit trail for every `match` command invocation (cache misses only).

```sql
CREATE TABLE match_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  page_category    TEXT,
  page_topics      TEXT,           -- JSON array
  page_description TEXT,
  candidate_count  INTEGER,        -- total classified groups available
  candidates_sent  INTEGER,        -- how many sent to LLM
  candidate_ids    TEXT,           -- JSON array of group IDs
  prescore_cutoff  REAL,           -- lowest pre-score in candidate set
  model            TEXT,           -- LLM model used
  raw_response     TEXT,           -- full LLM JSON response
  match_results    TEXT,           -- JSON array of final matches
  top_match_group  TEXT,
  top_match_score  REAL
);
```

**Written by:** `match` command on every LLM call (not on cache hits).

**Used by:** `match --audit` and `match --diagnose` for reviewing match history and debugging match quality.

---

### `match_feedback`

User corrections for match results — the training signal for improving match quality.

```sql
CREATE TABLE match_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  match_log_id    INTEGER REFERENCES match_log(id),
  url             TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expected_group  TEXT,
  expected_source TEXT,
  feedback_type   TEXT NOT NULL CHECK(feedback_type IN ('wrong_match','missing_match','correct','note')),
  notes           TEXT
);
```

**Feedback types:**
- `wrong_match` — the top result was wrong; expected a different group
- `missing_match` — the expected group didn't appear in results at all
- `correct` — the match was correct (positive reinforcement)
- `note` — freeform observation

**Written by:** `match --feedback` command.

**Used by:** `match --diagnose` to compare expected vs actual results and identify root causes (candidate selection failure, LLM ranking failure, or classification quality issue).

---

## Indexes

No explicit indexes are created. Query performance relies on:
- Primary key auto-indexes (`id`, `url`, `key`)
- Implicit indexes from UNIQUE constraints (`source, source_id` on groups; `group_id, url` on items)

## Concurrency

- **WAL mode** allows concurrent readers during writes
- No explicit transactions — each statement auto-commits
- The `classify` team workflow can run multiple agents writing simultaneously; SQLite's WAL handles this with brief write locks (occasional `SQLITE_BUSY` retries may be needed)

## Schema Evolution

Tables are created with `CREATE TABLE IF NOT EXISTS` — safe for idempotent startup. There is no migration versioning system. Adding columns would require manual `ALTER TABLE` or a fresh database.

## Data Flow

```
Safari (SafariTabs.db)  ──sync──▶  cache (~/.cache/)  ──update──▶  bookmarks.db
Raindrop.io API         ──sync──▶  cache (~/.cache/)  ──update──▶  bookmarks.db
                                                        classify──▶  bookmarks.db (classification fields)
                                                          match──▶  bookmarks.db (match_cache, match_log)
                                                       feedback──▶  bookmarks.db (match_feedback)
```

Only `src/index.ts` reads from and writes to `bookmarks.db`. Other source files (`sync.ts`, `safari.ts`, `raindrop.ts`) only interact with the upstream cache layer.
