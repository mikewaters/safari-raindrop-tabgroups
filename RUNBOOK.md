# Runbook

Common operational tasks for `safari-tabgroups`. Examples show both
`bun run` (development) and compiled binary forms.

## 1. Alpha Schema Reset Policy

This project is alpha software. There are no schema migrations.

If `bookmark-index` reports an unsupported schema:

1. Delete the existing database file.
2. Rebuild it from the source caches.
3. Re-run classification and enrichment.

Example:

```bash
rm -f ./bookmarks.db
bun run index update
bun run index classify -- --all
bun run index enrich -- --all

rm -f ~/.local/share/safari-tabgroups/bookmarks.db
bookmark-index update
bookmark-index classify --all
bookmark-index enrich --all
```

## 2. Synchronize Safari and Raindrop Sources

Pull fresh data into the local cache at `~/.cache/safari-tabgroups/`.
This must be run before any index operation.

```bash
# Sync both sources
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
WAL checkpoint. Raindrop sync fetches collections and bookmarks from the
API. If the Safari cache is already fresh, the copy is skipped.

## 3. Bootstrap a Fresh Index

The index database is created automatically on first use. The normal
bootstrap flow is:

1. Sync the source caches.
2. Build the SQLite index.
3. Generate Collection Cards.
4. Build retrieval embeddings and collection representations.

```bash
# Development workflow
bun run sync
bun run index update
bun run index classify -- --all
bun run index enrich -- --all

# Installed binary workflow
sync-tabgroups
bookmark-index update
bookmark-index classify --all
bookmark-index enrich --all
```

If you want richer Collection Cards during bootstrap:

```bash
bun run index classify -- --all --fetch
bookmark-index classify --all --fetch
```

The default database location is:

- `bun run` (dev): `./bookmarks.db` if `fetch.config.toml` points there
- compiled binary: `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`

## 4. Refresh an Existing Index

Use the same commands as bootstrap, but you usually only regenerate what
changed.

```bash
# Refresh cache, then refresh the index
bun run sync
bun run index update

sync-tabgroups
bookmark-index update

# Generate Collection Cards only for groups that do not have one yet
bun run index classify -- --all --unclassified
bookmark-index classify --all --unclassified

# Rebuild retrieval data for everything
bun run index enrich -- --all
bookmark-index enrich --all
```

Within the current schema revision, Collection Card versions are kept
across `update`. Across breaking schema revisions, reset the database and
rebuild from scratch.

## 5. Inspect a Group and Its Active Collection Card

```bash
# Human-readable output
bun run index show "My Research"
bookmark-index show "My Research"

# JSON output
bun run index show "My Research" -- --json
bookmark-index show "My Research" --json
```

Output includes:

- source and profile
- tab count and timestamps
- the active Collection Card version
- Collection Card fields:
  - `definition`
  - `includes`
  - `excludes`
  - `keyphrases`
  - `representative_entities`
- indexed tabs with URLs

If the group name is ambiguous, a partial match is attempted and likely
matches are suggested. Safari groups still take priority over Raindrop
when names collide.

## 6. Import or Manage Collection Cards

Generate or import cards:

```bash
# Generate for one group
bun run index classify "My Research"
bookmark-index classify "My Research"

# Import a manual card
cat card.json | bun run index classify -- --import "My Research"
cat card.json | bookmark-index classify --import "My Research"
```

Manage versions:

```bash
# List versions
bun run index version "My Research"
bookmark-index version "My Research"

# Copy active version into a draft
bun run index version "My Research" copy
bookmark-index version "My Research" copy

# Switch active version
bun run index version "My Research" set 2
bookmark-index version "My Research" set 2
```

Use `version copy` before manual edits when you want a new candidate card
without changing the currently active version.

## 7. Build or Refresh Retrieval Data

`bookmark-index enrich` computes:

- normalized URLs
- per-item signal packs
- extracted keyphrases and entities
- item embeddings
- collection centroids and exemplars
- drift/review signals

```bash
# Enrich everything
bun run index enrich -- --all
bookmark-index enrich --all

# Enrich one group
bun run index enrich "My Research"
bookmark-index enrich "My Research"
```

Operational note:

- The default embedding backend is the lazy-loaded local MiniLM model
  `local-minilm-l6-v2`.
- The first embedding call in a process may spend extra time loading or
  downloading the model.
- Later `enrich` and `match` calls in the same process reuse that model.

Run `enrich <group>` after changing a Collection Card, after recording
multiple match corrections for a group, or after source content shifts.

## 8. Match a URL and Triage Wrong Results

Run a match:

```bash
# Default local matcher
bun run index match "https://example.com"
bookmark-index match "https://example.com"

# Use the LLM matcher instead
bun run index match "https://example.com" -- --strategy llm-fetch
bookmark-index match "https://example.com" --strategy llm-fetch
```

Record feedback when the result is wrong or incomplete:

```bash
bun run index match -- --feedback "https://example.com" --expected "My Research" --type wrong_match
bookmark-index match --feedback "https://example.com" --expected "My Research" --type wrong_match
```

Inspect recent history:

```bash
bun run index match -- --audit
bookmark-index match --audit
```

Diagnose a specific URL:

```bash
bun run index match -- --diagnose "https://example.com"
bookmark-index match --diagnose "https://example.com"
```

Use `--diagnose` to inspect:

- page signal excerpt
- derived page keyphrases
- candidate counts and cutoff
- ambiguity metrics
- prior feedback for that URL

## 9. Run the Review Queue

Phase 3 adds a lightweight governance loop. `enrich` can queue a group
for review when drift, repeated confusion, or sustained ambiguity crosses
thresholds.

List open review items:

```bash
bun run index review list
bookmark-index review list
```

Inspect one queued group:

```bash
bun run index review show "My Research"
bookmark-index review show "My Research"
```

Compare Collection Card versions:

```bash
bun run index review diff "My Research"
bookmark-index review diff "My Research"
```

Approve the active or replacement version:

```bash
bun run index review approve "My Research"
bookmark-index review approve "My Research"

# Approve a specific version
bun run index review approve "My Research" 3
bookmark-index review approve "My Research" 3
```

Recommended loop:

1. Run `bookmark-index review list`.
2. Open the highest-priority item with `review show`.
3. Compare versions with `review diff` if a newer version exists.
4. Approve the correct version with `review approve`.
5. Re-run `enrich <group>` if the underlying source data changed.

## 10. Check Quality Metrics

Summarize quality over the default review window:

```bash
bun run index metrics
bookmark-index metrics
```

Change the time window:

```bash
bun run index metrics -- --days 7
bookmark-index metrics --days 7
```

Current metrics include:

- top-1 accuracy
- top-5 recall
- ambiguity rate
- override rate
- drift frequency

Use this as the quick health check after major matcher, prompt, or
Collection Card changes.

## 11. Use a Test Database

Use `--db <path>` on any `bookmark-index` subcommand to avoid touching
your real index.

```bash
# Create a disposable test database
bookmark-index update --db /tmp/test.db
bookmark-index classify --all --db /tmp/test.db
bookmark-index enrich --all --db /tmp/test.db

# Run matches and review flows against it
bookmark-index match "https://example.com" --db /tmp/test.db
bookmark-index review list --db /tmp/test.db
bookmark-index metrics --db /tmp/test.db

# bun run form
bun run index update -- --db /tmp/test.db
bun run index enrich -- --all --db /tmp/test.db
```

The `--db` flag overrides both the config file path and the XDG default.
The parent directory is created automatically if needed.

## 12. Golden Regression Workflow

The golden-set procedure is documented in
`GOLDEN-DATASET.md`. There is not yet a dedicated regression command.

Current manual workflow:

1. Refresh the index and retrieval data.
2. Maintain a `.jsonl` list of URLs and expected groups.
3. Re-run sampled matches after model, matcher, or prompt changes.
4. Use `bookmark-index metrics` plus spot checks from
   `bookmark-index match --diagnose` to compare behavior before and after.
