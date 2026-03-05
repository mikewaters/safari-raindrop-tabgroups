# Runbook

Common operational tasks for safari-tabgroups. All examples show both
`bun run` (development) and compiled binary forms.

> Important note: When running locally via `bun run`, the tool will use the local config file (and whichever database that points to). Only when using the compiled binaries will the tool use the user-facing configuration (and database path).
> To determine which database and ocnfig file is being used, simply run `bun run index stat` or `bookmark-index stat`.

---

## High Level Sync Architecture

1. Local cache of sources (`sync-tabgroups`)

Safari config DB --> User Cache
Raindrop API     --> User Cache

2. Combined bookmarks database (`bookmark-index`)

User cache --> Bookmarks.db (tab content only)

---

## 1. Synchronize Safari and Raindrop sources

Pulls fresh data into the local cache at `~/.cache/safari-tabgroups/`.
This must be run before any index operation — all other commands read
from this cache.

```bash
# Sync both sources (runs in parallel)
bun run sync
sync-tabgroups

# Sync only Safari
bun run sync -- --safari
sync-tabgroups --safari

# Sync only Raindrop
bun run sync -- --raindrop
sync-tabgroups --raindrop
```

Safari sync copies `SafariTabs.db` from the Safari container and runs a
WAL checkpoint. Raindrop sync fetches all collections and bookmarks from
the API. If the Safari cache is already fresh the copy is skipped.

---

## 2. Create a new index

The index database is created automatically on first use — there is no
separate "create" step. Just run `update` and the schema is built if
the database file does not exist.

```bash
# Create + populate from both sources
bun run index update
bookmark-index update

# Then classify all groups
bun run index classify -- --all
bookmark-index classify --all

# Or classify with richer page content (Tier 2)
bun run index classify -- --all --fetch
bookmark-index classify --all --fetch
```

The default database location is:
- **`bun run` (dev):** `./bookmarks.db` (from `fetch.config.toml`)
- **Compiled binary:** `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`
  (defaults to `~/.local/share/safari-tabgroups/bookmarks.db`)

---

## 3. Update an existing index

Same command as creation — `update` upserts groups and tabs from the
cache. Groups removed from the source are deleted from the index.
Classifications are preserved across updates.

```bash
# Re-sync cache, then update the index
bun run sync && bun run index update
sync-tabgroups && bookmark-index update

# Update only Safari side
bun run sync -- --safari && bun run index update -- --safari
sync-tabgroups --safari && bookmark-index update --safari

# Classify any newly added (unclassified) groups
bun run index classify -- --all --unclassified
bookmark-index classify --all --unclassified
```

---

## Classification snapshots

When classifying with `--fetch`, the markdown fetched from tab pages is stored as `page_snapshot` in the `group_classifications` table. This preserves the source material that informed each classification.

```bash
# Classify with page snapshots
bookmark-index classify --all --fetch

# Re-classify a single collection to capture snapshot
bookmark-index classify "Collection Name" --fetch
```

- `page_snapshot` is nullable — without `--fetch` or if all fetches fail, it's `NULL`
- An ERROR is logged to stderr if `--fetch` was used but no snapshot was captured
- Snapshots are versioned along with the classification — each version has its own snapshot

### Importing with snapshots

When using `--import`, include an optional `page_snapshot` field:

```bash
# Single import with snapshot
echo '{"description":"...","category":"research","topics":["ai"],"intent":"...","confidence":0.9,"page_snapshot":"# Page\nContent..."}' \
  | bookmark-index classify --import "Name" --author "agent"

# Batch import — each entry can independently include page_snapshot
echo '{"Group A": {"description":"...","category":"...","topics":[],"intent":"...","confidence":0.8,"page_snapshot":"..."}, "Group B": {...}}' \
  | bookmark-index classify --import --all --author "batch"
```

If `page_snapshot` is omitted from the import JSON, the classification is stored without one (no error).

**Large payloads:** For batch imports with snapshots, the stdin JSON can be large. Bun handles this fine, but prefer piping from a file rather than constructing inline:

```bash
cat classifications.json | bookmark-index classify --import --all --author "agent"
```

### Inspecting snapshots

```bash
# Via show command (JSON mode includes full classification)
bookmark-index show "Collection Name" --json | jq '.page_snapshot'

# Direct DB query
sqlite3 ~/.local/share/safari-tabgroups/bookmarks.db \
  "SELECT length(page_snapshot), substr(page_snapshot, 1, 200) FROM group_classifications WHERE group_id = 1 ORDER BY version DESC LIMIT 1"
```

---

## 4. Show detailed classification for a tab group

```bash
# Human-readable output
bun run index show "My Research"
bookmark-index show "My Research"

# JSON output
bun run index show "My Research" -- --json
bookmark-index show "My Research" --json
```

Output includes source, profile, tab count, timestamps, the active
classification (version, category, topics, description, intent,
confidence, author), and all indexed tabs with URLs.

Example:

```
[safari] My Research
Profile: Personal
Tabs: 8
Last active: 2024-01-15T10:30:00Z

Classification (v2 of 3) (2024-02-01T12:00:00Z):
  Category: research
  Topics: ["ai-agents", "agent-memory", "open-source"]
  Description: Research into AI agent frameworks and memory architectures.
  Intent: Evaluating agent frameworks to find or build a successor setup.
  Confidence: 0.95
  Author: openrouter/google/gemini-2.5-flash

Tabs:
  Some Page Title (1/15/2024)
    https://example.com/page
  Another Tab
    https://example.com/other
```

If the group name is ambiguous, a partial match is attempted and
suggestions are printed. Safari groups take priority over Raindrop
when names collide.

---

## 5. Match a new URL

The match process will return a confidence-scored list of potential target collections.

```bash
bun run index match "url" "optional hint"
bookmark-index match "url" "optional hint"
```

## 6. Target a test bookmarks database

Use `--db <path>` on any `bookmark-index` subcommand to point at a
different database file. This is useful for testing without touching
your real index.

```bash
# Create a test database from scratch
bookmark-index update --db /tmp/test.db
bookmark-index classify --all --db /tmp/test.db

# Run a match against the test database
bookmark-index match "https://example.com" --db /tmp/test.db

# Show a group from the test database
bookmark-index show "My Research" --db /tmp/test.db

# bun run form (flags go after --)
bun run index update -- --db /tmp/test.db
bun run index match "https://example.com" -- --db /tmp/test.db
```

The `--db` flag overrides both the config file path and the XDG default.
The parent directory is created automatically if it does not exist.

You can also change the default database path in the config file:

```toml
# fetch.config.toml (dev) or ~/.config/safari-tabgroups/config.toml (binary)
[database]
path = "/tmp/test.db"
```

Environment variables and `~` are expanded in the config path
(e.g. `$HOME/test.db` or `~/test.db`).

---

## 7. Stored metadata

The `metadata` JSON column on `items` and `groups` stores rich source data from Safari and Raindrop. This data is updated on every `bookmark-index update`.

**Safari tabs** — All columns from Safari's bookmarks table except `server_id` and binary blobs (`icon`, `sync_data`, `extra_attributes`, `local_attributes`). Includes `order_index`, `subtype`, `last_modified`, `external_uuid`, `date_closed`, `read`, and more. Core Data timestamps are converted to ISO 8601.

**Raindrop items** — All fields from the Raindrop API except `cover`. Includes `type`, `excerpt`, `note`, `tags`, `domain`, `important`, `broken`, `media`, `cache`, `user`, `creatorRef`, `sort`, `removed`, and more.

**Raindrop collections** (stored on `groups.metadata`) — All collection fields except `cover`, `_id`, `title`, and `parent` (stored as first-class columns). Includes `description`, `color`, `slug`, `access`, `author`, `count`, `creatorRef`, and more.

```bash
# View item metadata
bookmark-index show "Collection Name" --json | jq '.items[0].metadata'

# View collection metadata
bookmark-index show "Collection Name" --json | jq '.metadata'
```
