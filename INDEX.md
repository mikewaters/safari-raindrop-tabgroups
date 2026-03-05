# Index Logic

`bookmark-index` (`src/index.ts`) is the central CLI that maintains a unified SQLite index of Safari tab groups and Raindrop collections. All other commands (`sync`, `safari`, `raindrop`, `describe`, `fetch`) are upstream data producers — only `index.ts` reads from and writes to `bookmarks.db`.

## Architecture

```
sync-tabgroups ──> ~/.cache/safari-tabgroups/
                     ├── SafariTabs.db       (Safari tab groups database copy)
                     └── raindrop-collections.json  (Raindrop API snapshot)
                              │
bookmark-index update ───────────────────────> bookmarks.db
                                                  ├── groups    (tab groups + classifications)
                                                  ├── items     (individual tabs/bookmarks)
                                                  ├── meta      (sync timestamps)
                                                  ├── match_cache
                                                  ├── match_log
                                                  └── match_feedback
```

## Commands

### `update`

Syncs the index from cached upstream data. This is the only command that populates `groups` and `items`.

**Safari update** (`updateSafari`):
1. Spawns `safari.ts --json` as a subprocess to get tab group structure
2. Opens the cached `SafariTabs.db` directly (readonly) for plist blob access — extracts `last_active` timestamps via `getTabLastActive()` and `created_at` via `getDateAdded()` from binary plist attributes
3. Upserts each group with `ON CONFLICT(source, source_id) DO UPDATE` — preserves classification fields
4. Full-refreshes items: deletes all items for each group, re-inserts current tabs
5. Removes stale groups (present in DB but absent from upstream)

**Raindrop update** (`updateRaindrop`):
1. Reads `raindrop-collections.json` from cache
2. Builds parent title lookup for nested collections (e.g. `Current Projects / Agent Sandboxing`)
3. Groups raindrops by collection ID
4. Same upsert/refresh/prune pattern as Safari

**Key behaviors:**
- Classification fields (`description`, `category`, `topics`, etc.) are never overwritten by `update` — only `classify` writes those
- `created_at` uses `COALESCE(excluded, existing)` to never lose an earlier creation date
- Groups with 0 raindrops are skipped (no empty collections in the index)

### `list`

Lists all indexed groups. Ordered by `last_active DESC NULLS LAST`.

Filters: `--safari`, `--raindrop`. Output: `--json` for machine-readable.

Each row shows: source, name, profile, tab count, last active date, classification status.

### `show`

Displays full detail for a single group including all items and classification metadata.

Uses `resolveGroup()` for name lookup. On miss, does a `LIKE %name%` fuzzy search and suggests matches.

JSON mode (`--json`) parses the `topics` field from its stored JSON string into an array.

### `classify`

Populates classification fields for groups. Three modes:

**LLM mode** (`classify <name>` or `classify --all`):
- Spawns `describe-tabgroup` as a subprocess with the group name and source flag
- `describe-tabgroup` calls OpenRouter with the group's tabs and the system prompt from `[describe]` config
- Parses the JSON result and stores it via `storeClassification()`
- Re-classifying an already-classified group creates a new version (previous versions are preserved)
- `--unclassified` only processes groups without classification
- `--fetch` passes through to `describe-tabgroup` to fetch actual page content for richer analysis and stores the markdown as `page_snapshot`

**Import mode** (`classify --import <name>` or `classify --import --all`):
- Reads classification JSON from stdin
- Validates against required fields and configured categories
- Single mode: applies to one group via `resolveGroup()`
- Batch mode: input is `{ "Group Name": { ...classification } }` — applies to ALL groups matching each name (not just the first), enabling classification of duplicate-named groups across sources

### `match`

Finds which groups best fit a URL. See [MATCH.md](MATCH.md) for the full search pipeline.

## Name disambiguation

Multiple groups can share the same name across sources (e.g. a Safari tab group demoted to a Raindrop collection). The `resolveGroup()` helper handles this:

```sql
SELECT ... FROM groups WHERE name = ?
ORDER BY CASE WHEN source = 'safari' THEN 0 ELSE 1 END
LIMIT 1
```

Safari is preferred because it represents active browser sessions. This is used by `show`, `classify` (single), and `classify --import` (single). Batch import uses `.all()` instead to classify every matching group.

## Config resolution

Config is loaded from different locations depending on execution context:
- **Compiled binary** (`import.meta.dir` starts with `/$bunfs`): `$XDG_CONFIG_HOME/safari-tabgroups/config.toml`
- **`bun run` (dev)**: `./fetch.config.toml` in CWD

Shared via `src/config.ts` — used by all TypeScript entry points.

## Database path resolution

1. `--db <path>` flag (highest priority)
2. `database.path` from config file (supports `$ENV_VAR` and `~` expansion)
3. Default: `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`

## Debug logging

All commands support `--verbose` / `--debug` flags. Debug output goes to stderr via `log()`, keeping stdout clean for data output. Key debug points:
- Config file path
- Database path
- Safari/Raindrop subprocess output
- Pre-scoring statistics (match command)
- Cache hit/miss status
- LLM API calls

## File structure

| File | Role |
|------|------|
| `src/index.ts` | CLI entry point, all commands, database management |
| `src/config.ts` | Shared config path resolver |
| `src/safari.ts` | Reads Safari tab groups from cached SQLite DB |
| `src/raindrop.ts` | Reads Raindrop collections from cached JSON |
| `src/describe.ts` | LLM classification via OpenRouter |
| `src/fetch.ts` | URL-to-markdown fetcher with optional LLM analysis |
| `src/sync.ts` | Cache refresh from upstream sources |
| `src/plist.ts` | Binary plist parsing for Safari timestamp extraction |
| `fetch.config.toml` | All configuration (API keys, models, categories, match settings) |
