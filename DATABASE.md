# Database Schema — bookmark-index

The `bookmark-index` CLI stores all data in a single SQLite database.

## Alpha Schema Policy

- This project is alpha software.
- There is no schema migration path.
- Old database files are not supported once the schema changes.
- If `bookmark-index` reports an unsupported schema, delete the DB file and rerun `bookmark-index update`.

## Location

Default: `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db` (typically `~/.local/share/safari-tabgroups/bookmarks.db`)

Override via:
- `--db <path>` CLI flag
- `database.path` in `fetch.config.toml`

## Tables

### `groups`

Primary table. Each row is a Safari tab group or Raindrop collection.

```sql
CREATE TABLE groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL CHECK(source IN ('safari', 'raindrop')),
  source_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  profile        TEXT,
  tab_count      INTEGER NOT NULL DEFAULT 0,
  last_active    TEXT,
  created_at     TEXT,
  active_version INTEGER REFERENCES group_classifications(id),
  updated_at     TEXT NOT NULL,
  UNIQUE(source, source_id)
);
```

`active_version` points to the currently selected Collection Card version for the group.

### `items`

Child table. Each row is a tab or bookmark within a group.

```sql
CREATE TABLE items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id              INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  url                   TEXT NOT NULL,
  last_active           TEXT,
  created_at            TEXT,
  normalized_url        TEXT,
  signal_pack_text      TEXT,
  embedding_vector      TEXT,
  embedding_model_version TEXT,
  extracted_keyphrases  TEXT,
  extracted_entities    TEXT,
  signals_updated_at    TEXT,
  UNIQUE(group_id, url)
);
```

Phase 2 adds the derived retrieval fields used by `bookmark-index enrich`.

### `group_classifications`

The historical table name is retained, but it now stores Collection Card versions only.

```sql
CREATE TABLE group_classifications (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id                     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  version                      INTEGER NOT NULL,
  definition                   TEXT,
  includes_json                TEXT NOT NULL,
  excludes_json                TEXT NOT NULL,
  keyphrases_json              TEXT NOT NULL,
  representative_entities_json TEXT NOT NULL,
  generated_by                 TEXT NOT NULL CHECK(generated_by IN ('system','manual')),
  model_version                TEXT,
  last_generated_at            TEXT,
  last_reviewed_at             TEXT,
  author                       TEXT,
  card_schema_version          INTEGER NOT NULL DEFAULT 1,
  created_at                   TEXT NOT NULL,
  UNIQUE(group_id, version)
);
```

Each row is one version of a Collection Card. The active version is chosen by `groups.active_version`.

### `collection_representations`

Stores the collection-level retrieval representation used by `card-match`.

```sql
CREATE TABLE collection_representations (
  group_id                INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  centroid_vector         TEXT,
  exemplar_vectors        TEXT,
  embedding_model_version TEXT,
  source_item_count       INTEGER NOT NULL DEFAULT 0,
  keyword_signature       TEXT,
  entity_signature        TEXT,
  last_drift_score        REAL,
  updated_at              TEXT NOT NULL
);
```

Phase 3 adds the keyword/entity signatures and last computed drift score so `enrich` can queue collections for review.

### `collection_review_queue`

Stores open and resolved governance items produced by `bookmark-index enrich`.

```sql
CREATE TABLE collection_review_queue (
  group_id         INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK(status IN ('open','approved','dismissed')),
  priority         REAL NOT NULL DEFAULT 0,
  reasons_json     TEXT NOT NULL,
  drift_score      REAL NOT NULL DEFAULT 0,
  confusion_count  INTEGER NOT NULL DEFAULT 0,
  ambiguity_rate   REAL NOT NULL DEFAULT 0,
  queued_at        TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  reviewed_at      TEXT,
  reviewed_version INTEGER,
  resolution_notes TEXT
);
```

### `match_cache`

Caches `match` command results.

```sql
CREATE TABLE match_cache (
  url       TEXT PRIMARY KEY,
  result    TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
```

`result` stores JSON in the shape:

```json
{
  "classification": null,
  "matches": [
    {
      "group": "Name",
      "source": "safari",
      "score": 0.85,
      "reason": "definition overlap; keyphrase match"
    }
  ]
}
```

### `match_log`

Audit trail for fresh `match` executions.

```sql
CREATE TABLE match_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  url               TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  page_signal_excerpt TEXT,
  page_keyphrases   TEXT,
  candidate_count   INTEGER,
  candidates_sent   INTEGER,
  candidate_ids     TEXT,
  prescore_cutoff   REAL,
  strategy_name     TEXT,
  model             TEXT,
  raw_response      TEXT,
  match_results     TEXT,
  top_match_group   TEXT,
  top_match_score   REAL,
  top1_margin       REAL,
  topk_entropy      REAL,
  is_ambiguous      INTEGER
);
```

### `match_feedback`

User corrections for match results.

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

### `meta`

Key-value store for sync metadata.

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## Data Flow

```text
Safari cache / Raindrop cache -> bookmark-index update -> groups + items
describe-tabgroup / classify --import -> group_classifications
bookmark-index enrich -> items (derived retrieval fields) + collection_representations
bookmark-index enrich -> collection_review_queue (for drifted collections)
bookmark-index match -> match_cache + match_log
bookmark-index match --feedback -> match_feedback
bookmark-index review -> collection_review_queue + group_classifications.last_reviewed_at
```
