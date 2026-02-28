# safari-tabgroups

A CLI toolkit for extracting, analyzing, and describing Safari tab groups. Built with [Bun](https://bun.sh).

## Prerequisites

- macOS (reads Safari's local SQLite database)
- [Bun](https://bun.sh) v1.3+
- An [OpenRouter](https://openrouter.ai) API key (for `fetch --prompt` and `describe` commands)

## Install

```bash
bun install
make install          # builds + copies to /usr/local/bin
# or install elsewhere:
PREFIX=~/.local/bin make install
```

## Commands

### safari-tabgroups

Reads Safari's tab group database and outputs all tab groups with their tabs.

```bash
# Human-readable output
bun run start

# JSON output
bun run start -- --json

# Use cached database (skip copying from Safari)
bun run start -- --cached

# Use Safari Technology Preview instead of Safari
bun run start -- --stp

# Pipe JSON to jq
bun run start -- --json | jq '.profiles[].tabGroups[].name'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (`{ profiles: [...] }`) |
| `--cached` | Use previously cached database (faster, no Safari access needed) |
| `--stp` | Read from Safari Technology Preview instead of Safari |
| `--verbose` | Print debug info to stderr |
| `--debug` | Like `--verbose`, also saves a timestamped copy of the database to CWD |

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

**How it works:**

1. Copies Safari's `SafariTabs.db` (plus WAL/SHM files) to `~/.cache/safari-tabgroups/`. Skips the copy if the cache is already up to date.
2. Queries the `bookmarks` table to discover profiles, tab groups, and tabs.
3. Outputs the results to stdout.

The database is never read in-place -- always from a cached copy.

---

### fetch

Fetches a URL and converts it to markdown. Optionally sends the markdown to an LLM via OpenRouter.

```bash
# Fetch a URL and output markdown
bun run fetch "https://example.com"

# Fetch and ask an LLM about the content
bun run fetch "https://example.com" --prompt "Summarize this page in 3 bullet points"

# Debug mode: save raw markdown to a file before sending to LLM
bun run fetch "https://example.com" --prompt "Summarize this" --debug
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Send the fetched markdown to OpenRouter with this user prompt |
| `--verbose` | Print debug info to stderr |
| `--debug` | Implies `--verbose`. When used with `--prompt`, saves the raw markdown to `./debug-<timestamp>.md` before the LLM call |

**Without `--prompt`:** outputs the converted markdown to stdout and exits. No config or API key needed.

**With `--prompt`:** loads `fetch.config.toml`, truncates the markdown to `max_content_bytes`, and sends it to the configured OpenRouter model. The user message sent to the LLM is:

```
<your prompt text>

<truncated markdown>
```

The LLM response is printed to stdout.

---

### describe

Derives structured metadata about Safari tab groups using an LLM. Operates in two tiers:

- **Tier 1 (default):** Sends only tab titles and URLs to the LLM. Fast and cheap.
- **Tier 2 (`--fetch`):** Also fetches and includes page content for the top N tabs, providing richer context for groups with opaque tab titles.

```bash
# Describe a single tab group (Tier 1: titles/URLs only)
bun run describe "My Research"

# Describe with page content (Tier 2)
bun run describe "My Research" --fetch

# Describe all tab groups
bun run describe -- --all

# See the assembled prompt sent to the LLM
bun run describe "My Research" --verbose
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--all` | Describe all tab groups (outputs a JSON object keyed by group name) |
| `--fetch` | Tier 2: fetch markdown from the top N tabs and include in the prompt |
| `--verbose` | Print debug info to stderr, including the full assembled prompt |
| `--debug` | Implies `--verbose` |

**Output (single group):**

```json
{
  "description": "Research into AI agent frameworks and their memory architectures.",
  "category": "research",
  "topics": ["ai-agents", "agent-memory", "open-source"],
  "intent": "Evaluating agent frameworks to find or build a successor setup.",
  "confidence": 0.95
}
```

**Output (`--all`):** a JSON object where each key is a tab group name:

```json
{
  "My Research": { "description": "...", "category": "...", ... },
  "Shopping": { "description": "...", "category": "...", ... }
}
```

**Output fields:**

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | 1-2 sentence summary of the tab group's content and purpose |
| `category` | string | One of: `project`, `research`, `shopping`, `reference`, `entertainment`, `troubleshooting`, `setup`, `learning` |
| `topics` | string[] | 2-5 lowercase topic tags |
| `intent` | string | What the user is likely trying to accomplish |
| `confidence` | number | 0.0-1.0 confidence in the classification |

**How it works:**

1. Runs `safari-tabgroups --json --cached` as a subprocess to get tab group data
2. Assembles a prompt with the group name and tab listing
3. If `--fetch`: selects the top N eligible tabs (filtered by `skip_domains`), fetches each page's markdown, truncates to `per_tab_max_bytes`, and appends to the prompt
4. Sends to OpenRouter and parses the JSON response

**Tier 2 tab selection:** Tabs are selected in order_index order (the order the user arranged them). Tabs on domains in the `skip_domains` list and `*.ts.net` hosts are automatically skipped.

---

### raindrop

Fetches Raindrop.io bookmark collections and outputs them in the same JSON schema as `safari-tabgroups --json`. Collections map to tab groups; raindrops (bookmarks) map to tabs.

```bash
# Export all Raindrop.io collections as tab groups JSON
bun run raindrop

# With debug logging
bun run raindrop -- --verbose

# Pipe to jq
bun run raindrop | jq '.profiles[0].tabGroups[] | .name'
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--verbose` | Print debug info to stderr (API calls, collection counts) |
| `--debug` | Implies `--verbose` |

**Setup:**

1. Create a test token at https://app.raindrop.io/settings/integrations
2. Set the environment variable: `export RAINDROP_TOKEN="your-token"`
3. The token is read from `fetch.config.toml`:
   ```toml
   [raindrop]
   api_key = "$RAINDROP_TOKEN"
   ```

**How it works:**

1. Fetches root collections (`GET /collections`) and child collections (`GET /collections/childrens`) in parallel
2. For each non-empty collection, paginates through all raindrops (`GET /raindrops/{id}?perpage=50`)
3. Nested collections are flattened with `"Parent / Child"` naming (e.g. a child collection "Frameworks" under "Dev Tools" becomes `"Dev Tools / Frameworks"`)
4. All collections are placed under a single profile named `"Raindrop.io"`
5. Outputs JSON conforming to `schema.json`

**What maps:**

| Safari Schema | Raindrop.io | Notes |
|---|---|---|
| Profile | — | Single profile `"Raindrop.io"` |
| TabGroup.name | Collection.title | Direct match |
| Tab.title | Raindrop.title | Direct match |
| Tab.url | Raindrop.link | Direct match |

**What is dropped:** Raindrop-specific metadata (tags, notes, highlights, type, dates, cover) and collection metadata (color, view, sort) are not represented in the schema and are discarded.

---

## Configuration

All settings are stored in `fetch.config.toml` at the project root.

```toml
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

### `[openrouter]` section

Used by both `fetch` and `describe` commands.

| Key | Type | Description |
|-----|------|-------------|
| `api_key` | string | OpenRouter API key. Prefix with `$` to read from an environment variable (e.g. `"$OPENROUTER_API_KEY"`) |
| `model` | string | [OpenRouter model ID](https://openrouter.ai/models) (e.g. `google/gemini-2.5-flash`, `anthropic/claude-sonnet-4`) |
| `system_prompt` | string | Default system prompt for LLM calls |
| `max_content_bytes` | integer | Maximum bytes of markdown content to include in the prompt (used by `fetch`) |
| `max_tokens` | integer | Maximum tokens in the LLM response |

### `[raindrop]` section

Used by the `raindrop` command.

| Key | Type | Description |
|-----|------|-------------|
| `api_key` | string | Raindrop.io API token. Prefix with `$` to read from an environment variable (e.g. `"$RAINDROP_TOKEN"`) |

### `[describe]` section

Settings specific to the `describe` command.

| Key | Type | Description |
|-----|------|-------------|
| `max_tabs_to_fetch` | integer | Number of tabs to fetch when using `--fetch` (Tier 2) |
| `skip_domains` | string[] | Domains to skip when fetching tab content |
| `per_tab_max_bytes` | integer | Max bytes of markdown to include per fetched tab |
| `system_prompt` | string | System prompt for describe. Falls back to `[openrouter].system_prompt` if empty |

### Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | `fetch`, `describe` | OpenRouter API key (referenced via `$OPENROUTER_API_KEY` in config) |
| `RAINDROP_TOKEN` | `raindrop` | Raindrop.io API token |

---

## Building

```bash
make build            # compile all standalone binaries
make install          # build + install to /usr/local/bin
make install PREFIX=~/.local/bin  # custom install path
make uninstall        # remove installed binaries
make clean            # remove compiled binaries from project dir
```

Compiled binaries:

| Binary | Source | Description |
|--------|--------|-------------|
| `safari-tabgroups` | `src/index.ts` | Safari tab group reader |
| `fetch-tabgroup` | `src/fetch.ts` | URL-to-markdown + LLM |
| `describe-tabgroup` | `src/describe.ts` | Tab group metadata derivation |
| `raindrop-tabgroups` | `src/raindrop.ts` | Raindrop.io adapter |

## Development

```bash
bun install                        # install dependencies
bun run src/index.ts --json        # run from source
bun run src/fetch.ts "https://example.com"
bun run src/describe.ts "GroupName" --verbose
bun run src/raindrop.ts --verbose
```

## Architecture

```
src/
  index.ts       Safari SQLite reader - extracts tab groups from SafariTabs.db
  fetch.ts       URL-to-markdown converter with optional LLM analysis
  describe.ts    Tab group metadata derivation via LLM (calls index.ts internally)
  raindrop.ts    Raindrop.io adapter - same output schema as index.ts

fetch.config.toml   Shared configuration (API keys, LLM settings, describe options)
Makefile            Build and install targets
```

`describe.ts` depends on `index.ts` at runtime -- it spawns it as a subprocess with `--json --cached` to get tab group data. All other commands are independent.

`fetch.ts` and `describe.ts` share the `[openrouter]` config section and use the same OpenRouter chat completions API pattern via native `fetch()` (no SDK). `raindrop.ts` reads its own `[raindrop]` config section and calls the Raindrop.io REST API directly.
