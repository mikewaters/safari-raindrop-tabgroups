# safari-tabgroups

A CLI toolkit for extracting, listing, and describing browser tab groups from Safari and Raindrop.io. Built with [Bun](https://bun.sh).

## Prerequisites

- macOS (reads Safari's local SQLite database)
- [Bun](https://bun.sh) v1.3+
- An [OpenRouter](https://openrouter.ai) API key (for `fetch --prompt` and `describe` commands)
- A [Raindrop.io](https://raindrop.io) API token (for syncing Raindrop collections)

## Install

```bash
bun install
make install          # builds + copies to /usr/local/bin
# or install elsewhere:
PREFIX=~/.local/bin make install
```

## Commands

1. `sync-tabgroups` - Sync our cache of sources
2. `safari-tabgroups` - Read safari data from cached source
3. `raindrop-tabgroups` - Read raindrop data from cached source
4. `list-tabgroups` - List combined cached source data
5. `describe-tabgroup` - Perform classification of bookmarks data
6. `bookmark-index` - Manages bookmarks data in a database and orchestrate

### sync-tabgroups

Populates the local cache for Safari and/or Raindrop.io. All other commands read from this cache — run sync first.

```bash
# Sync both sources
bun run sync

# Sync only Safari
bun run sync -- --safari

# Sync only Raindrop.io
bun run sync -- --raindrop

# Sync from Safari Technology Preview
bun run sync -- --safari --stp
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--safari` | Only sync Safari tab groups |
| `--raindrop` | Only sync Raindrop.io collections |
| `--full-raindrop` | Force full Raindrop sync (skip delta mode) |
| `--stp` | Sync from Safari Technology Preview instead of Safari |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose` |

Without `--safari` or `--raindrop`, syncs both sources.

**How it works:**

- **Safari:** Copies `SafariTabs.db` (plus WAL/SHM files) to `~/.cache/safari-tabgroups/`, skipping the copy if the cache is already fresh. Runs a WAL checkpoint to consolidate writes.
- **Raindrop:** Fetches collections on every run. If a prior cache exists, performs a delta sync using `lastUpdate:>fetchedAt` and merges changes by raindrop ID; use `--full-raindrop` to force a complete refresh (recommended periodically to reconcile deletions). Cache is written to `~/.cache/safari-tabgroups/raindrop-collections.json`.

When syncing both, sources are fetched in parallel.

---

### safari-tabgroups

Reads Safari tab groups from the local cache.

```bash
# Human-readable output
bun run safari

# JSON output
bun run safari -- --json

# Pipe JSON to jq
bun run safari -- --json | jq '.profiles[].tabGroups[].name'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (`{ profiles: [...] }`) |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose` |

**Text output (default):** one line per tab as `Profile / Tab Group / Title (URL)`

```
Personal / Research / Some Page (https://example.com)
Personal / Work / Jira Board (https://jira.example.com)
```

**JSON output (`--json`):**

```json
{
  "profiles": [
    {
      "name": "Personal",
      "tabGroups": [
        {
          "name": "Research",
          "tabs": [
            { "title": "Some Page", "url": "https://example.com" }
          ]
        }
      ]
    }
  ]
}
```

---

### raindrop-tabgroups

Reads Raindrop.io collections from the local cache, output in the same schema as `safari-tabgroups`.

```bash
# Human-readable output
bun run raindrop

# JSON output
bun run raindrop -- --json

# Pipe to jq
bun run raindrop -- --json | jq '.profiles[0].tabGroups[] | .name'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (`{ profiles: [...] }`) |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose` |

**Mapping:** Collections map to tab groups; raindrops (bookmarks) map to tabs. Nested collections are flattened with `"Parent / Child"` naming. All collections are placed under a single profile named `"Raindrop.io"`.

---

### list-tabgroups

Lists all tab group names across both sources.

```bash
# Plain text listing
bun run list

# JSON output
bun run list -- --json

# Only Safari groups
bun run list -- --safari

# Only Raindrop groups
bun run list -- --raindrop
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output merged JSON (`{ profiles: [...] }`) |
| `--safari` | Only include Safari tab groups |
| `--raindrop` | Only include Raindrop.io collections |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose` |

**Text output (default):**

```
Personal
  Research (12 tabs)
  Work (3 tabs)

Raindrop.io
  AI Tools (8 tabs)
  Reading List (4 tabs)
```

---

### describe-tabgroup

Derives structured metadata about tab groups using an LLM. Works with both Safari and Raindrop sources.

- **Tier 1 (default):** Sends only tab titles and URLs to the LLM. Fast and cheap.
- **Tier 2 (`--fetch`):** Also fetches and includes page content for the top N tabs, providing richer context.

```bash
# Describe a single tab group
bun run describe "My Research"

# Describe with page content (Tier 2)
bun run describe "My Research" -- --fetch

# Describe all tab groups
bun run describe -- --all

# Only describe Safari groups
bun run describe -- --all --safari

# Only describe Raindrop groups
bun run describe -- --all --raindrop
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--all` | Describe all tab groups (outputs a JSON object keyed by group name) |
| `--fetch` | Tier 2: fetch markdown from the top N tabs and include in the prompt |
| `--safari` | Only include Safari tab groups |
| `--raindrop` | Only include Raindrop.io collections |
| `--verbose` | Print debug info to stderr, including the full assembled prompt |
| `--debug` | Implies `--verbose` |

**Output (single group):**

```json
{
  "description": "Research into AI agent frameworks and their memory architectures.",
  "category": "research",
  "topics": ["ai-agents", "agent-memory", "open-source"],
  "intent": "Evaluating agent frameworks to find or build a successor setup.",
  "confidence": 0.95,
  "page_snapshot": "## Agent Memory Docs\nMarkdown content from fetched pages..."
}
```

When `--fetch` is used, the fetched markdown content is included as `page_snapshot` in the output. This is stored alongside the classification in the database. Without `--fetch`, `page_snapshot` is omitted.

**Output (`--all`):** a JSON object where each key is a tab group name.

---

### bookmark-index

Maintains a unified SQLite index of Safari tab groups and Raindrop collections. Supports LLM-powered classification and URL matching against stored groups.

```bash
# Sync index from cached data
bun run index update

# List all indexed groups
bun run index list

# Show full detail for a group
bun run index show "My Research"

# Classify groups using LLM
bun run index classify --all

# Match a URL against classified groups
bun run index match "https://example.com"
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--db <path>` | Override database location (default: `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`) |
| `--json` | Output as JSON |
| `--safari` | Only include Safari tab groups |
| `--raindrop` | Only include Raindrop.io collections |
| `--all` | Classify all groups |
| `--fetch` | Include page content when classifying and store page snapshot |
| `--unclassified` | Only classify groups without existing classification |
| `--top N` | Limit match results (default: 5) |
| `--strategy NAME` | Match strategy to use (default: `llm-fetch`) |
| `--verbose` | Print debug info to stderr |

Re-classifying an already-classified collection creates a new version — previous versions are preserved and can be managed with `bookmark-index version`.

The database defaults to `~/.local/share/safari-tabgroups/bookmarks.db` (following the XDG Base Directory spec). This can be configured in `fetch.config.toml` or overridden per-invocation with `--db`.

---

### fetch-tabgroup

Fetches a URL and converts it to markdown. Optionally sends the markdown to an LLM via OpenRouter.

```bash
# Fetch a URL and output markdown
bun run fetch "https://example.com"

# Fetch and ask an LLM about the content
bun run fetch "https://example.com" --prompt "Summarize this page in 3 bullet points"
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Send the fetched markdown to OpenRouter with this user prompt |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose`. Saves raw markdown to `./debug-<timestamp>.md` |

---

## Configuration

All settings are stored in `fetch.config.toml` at the project root.

```toml
[database]
path = "$XDG_DATA_HOME/safari-tabgroups/bookmarks.db"  # Supports $ENV_VAR syntax; falls back to ~/.local/share

[openrouter]
api_key = "$OPENROUTER_API_KEY"     # Supports $ENV_VAR syntax
model = "google/gemini-2.5-flash"
system_prompt = "You are a helpful assistant that analyzes web page content."
max_content_bytes = 40_000          # Max markdown bytes sent to LLM (fetch command)
max_tokens = 1_000                  # Max response tokens from the LLM

[raindrop]
api_key = "$RAINDROP_TOKEN"         # Raindrop.io API token

[describe]
max_tabs_to_fetch = 5               # How many tabs to fetch in Tier 2
skip_domains = ["discord.com", "localhost"]
per_tab_max_bytes = 500             # Max bytes of markdown per tab in Tier 2
system_prompt = """
You are a research librarian cataloging a user's browser tab groups...
"""
```

### Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | `fetch`, `describe`, `index` | OpenRouter API key |
| `RAINDROP_TOKEN` | `sync` | Raindrop.io API token |
| `XDG_DATA_HOME` | `index` | Base directory for persistent data (default: `~/.local/share`) |

---

## Building

Compiled binaries are produced under `dist/`. `make install` copies them from there to `PREFIX`.

```bash
make build            # compile all standalone binaries into dist/
make install          # build + install to /usr/local/bin
make install PREFIX=~/.local/bin  # custom install path
make uninstall        # remove installed binaries
make clean            # remove dist/ and build artifacts
```

Compiled binaries:

| Binary | Source | Description |
|--------|--------|-------------|
| `sync-tabgroups` | `src/sync.ts` | Cache population for Safari and Raindrop |
| `safari-tabgroups` | `src/safari.ts` | Safari tab group reader (read-only) |
| `raindrop-tabgroups` | `src/raindrop.ts` | Raindrop.io collection reader (read-only) |
| `list-tabgroups` | `src/list.ts` | List all tab group names |
| `describe-tabgroup` | `src/describe.ts` | Tab group metadata derivation via LLM |
| `fetch-tabgroup` | `src/fetch.ts` | URL-to-markdown + optional LLM analysis |
| `bookmark-index` | `src/index.ts` | Unified index with classification and URL matching |

## Database

The index database (`bookmarks.db`) stores collections, their items, and LLM-generated classifications.

### Schema overview

| Table | Description |
|-------|-------------|
| `groups` | Collections from Safari and Raindrop with inline classification fields |
| `items` | Individual bookmarks/tabs within each group |
| `group_classifications` | Versioned Collection Cards with `page_snapshot` |
| `highlights` | Raindrop highlights linked to items |
| `match_log` / `match_cache` | URL match history and caching |
| `match_feedback` | User feedback on match quality |
| `meta` | Key-value metadata (last sync times) |

### Classification snapshots

When classifying with `--fetch`, the markdown fetched from tab pages is stored as `page_snapshot` in `group_classifications`. This preserves the source material that informed each classification.

- The field is nullable — classifications without `--fetch` or where all fetches failed have `NULL`
- When using `--import`, include an optional `page_snapshot` field in the JSON
- An ERROR is logged if `--fetch` is used but no snapshot is captured

### Stored metadata

The `metadata` JSON column on `items` and `groups` stores rich source data:

**Safari tabs** — All columns from Safari's bookmarks table except `server_id` and binary blobs (`icon`, `sync_data`, `extra_attributes`, `local_attributes`). Includes `order_index`, `subtype`, `last_modified`, `external_uuid`, `date_closed`, `read`, and more. Core Data timestamps are converted to ISO 8601.

**Raindrop items** — All fields from the Raindrop API except `cover`. Includes `type`, `excerpt`, `note`, `tags`, `domain`, `important`, `broken`, `media`, `cache`, `user`, `creatorRef`, `sort`, `removed`, and more.

**Raindrop collections** — All collection fields except `cover`, `_id`, `title`, and `parent` (stored as first-class columns). Includes `description`, `color`, `slug`, `access`, `author`, `count`, `creatorRef`, and more.

---

## Architecture

```
src/
  sync.ts        Cache population — copies Safari DB, fetches Raindrop API
  safari.ts      Safari SQLite reader — reads tab groups from cached SafariTabs.db
  raindrop.ts    Raindrop.io reader — reads collections from cached JSON
  list.ts        Lists tab group names from both sources
  describe.ts    Tab group metadata derivation via LLM (spawns safari.ts and raindrop.ts)
  fetch.ts       URL-to-markdown converter with optional LLM analysis
  index.ts       Unified bookmark index — stores groups, classifications, and matches
  match/
    types.ts     MatchStrategy interface and strategy registry
    llm-fetch.ts LLM-based match strategy (pre-score + OpenRouter)
  plist.ts       Apple plist parser for Safari timestamp extraction

fetch.config.toml   Shared configuration (API keys, LLM settings, database path)
Makefile            Build and install targets
```

`describe.ts` and `list.ts` spawn `safari.ts` and `raindrop.ts` as subprocesses to get tab group data. All reader commands are read-only — only `sync.ts` writes to the cache. `index.ts` maintains its own SQLite database at `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db` (configurable).
