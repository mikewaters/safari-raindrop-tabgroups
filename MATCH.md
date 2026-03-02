# Match Search Logic

The `match` command finds which bookmark groups best fit a given URL. Matching is handled by pluggable **strategies** selected via `--strategy NAME` (default: `llm-fetch`).

## Strategy architecture

Match strategies implement the `MatchStrategy` interface (`src/match/types.ts`):

```typescript
interface MatchStrategy {
  name: string;
  match(params: MatchParams): Promise<MatchResult>;
}
```

Strategies receive the URL, optional hint, database handle, config, classified groups, and flags. They return a classification, ranked matches, and metadata for audit logging. Cache management, audit logging, and output formatting are handled by `cmdMatch()` in `index.ts` — strategies only perform the core matching.

Strategies self-register at module load via the `strategyRegistry` map. Unknown `--strategy` values produce an error listing available strategies.

### Available strategies

| Name | File | Description |
|------|------|-------------|
| `llm-fetch` | `src/match/llm-fetch.ts` | Two-stage pipeline: local pre-scoring + LLM ranking via OpenRouter (default) |

### Adding a new strategy

1. Create a file in `src/match/` implementing `MatchStrategy`
2. Register it: `strategyRegistry.set("my-strategy", () => new MyStrategy())`
3. Import the file in `src/index.ts` (the named import triggers registration)

## `llm-fetch` strategy

The default strategy uses a two-stage pipeline: fast local pre-scoring for 100% group coverage, then an LLM for semantic ranking of the top candidates.

### Pipeline overview

```
URL ──fetch──> markdown ──extractPageSignals──> keywords
                                                  │
all classified groups ──scoreGroupCandidates──> ranked by local score
                                                  │
                                            top N candidates ──LLM──> classification + matches
                                                                           │
                                                                    recency boost ──> final ranked output
                                                                           │
                                                                    match_cache + match_log
```

## Stage 1: Local pre-scoring

Every classified group is scored against the page content without any LLM call. This ensures 100% coverage — no group is excluded by arbitrary ordering.

### Signal extraction (`extractPageSignals`)

Given the URL and its fetched markdown, produces a `PageSignals` object:

1. **URL parsing** — hostname (without `www.`), path segments
2. **Title** — first `# heading` in the markdown
3. **Keywords** — all words (3+ chars, regex `[a-z][a-z0-9-]{2,}`) from the full markdown text, with stop words removed. Hyphenated words are also split into parts (e.g. `cloud-computing` adds both `cloud-computing`, `cloud`, and `computing`). Hostname parts and path segments are added as keywords too.

### Group scoring (`scoreGroupCandidates`)

Each group gets a weighted score from 4 signals:

| Signal | Weight | Scoring |
|--------|--------|---------|
| **Topic overlap** | 0.4 | Each group topic tag is split on `-` into parts. A topic matches if any of its parts appears in the page keywords (exact match or substring). Score = matched topics / total topics. |
| **Name + description overlap** | 0.3 | Group name and description are tokenized. Score = matched tokens / total unique tokens. |
| **Category match** | 0.15 | 1.0 if the group's category word appears in page keywords, else 0.0. |
| **Domain match** | 0.15 | 1.0 if any item URL in the group contains the page's hostname, else 0.0. |

**Final local score** = `topic * 0.4 + nameDesc * 0.3 + category * 0.15 + domain * 0.15`

The top `max_groups_in_prompt` groups (default: 30) by local score are sent to the LLM.

### Substring matching

Topic matching is intentionally fuzzy. For a topic like `agent-sandboxing`:
- Splits to parts: `agent`, `sandboxing`
- Checks each part against page keywords using both exact match and bidirectional substring (`kw.includes(part) || part.includes(kw)`)
- This catches `sandbox` matching `sandboxing`, `container` matching `containers`, etc.

## Stage 2: LLM matching

### Prompt structure

**System prompt** (configurable in `fetch.config.toml [match]`):
> You are a research librarian. A user has found a web page and wants to know which of their existing bookmark groups it best fits into...

**User message** contains three sections:
1. `## Web Page URL` — the raw URL
2. `## Web Page Content` — markdown truncated to `max_page_bytes` (default 20,000)
3. `## Candidate Groups` — one line per candidate:
   ```
   1. [safari] "Group Name" — category | topics: [...] | pre-score: 0.XX | description
   ```

### LLM response

The LLM returns JSON with:
- `classification` — the page's category, topics, and description (same schema as group classifications)
- `matches` — array of `{group, source, score, reason}` for groups scoring above 0.3

### Post-processing

**Recency boost** — adjusts each match score based on the group's `last_active` timestamp:

| Group activity | Boost |
|---------------|-------|
| Within 7 days | +0.15 |
| Within 30 days | +0.10 |
| Within 90 days | +0.05 |
| Older | +0.00 |

Final score is capped at 1.0. Matches are re-sorted by boosted score and trimmed to `--top N` (default 5).

## Caching

Results are cached in the `match_cache` table keyed by URL. TTL is configured via `match.cache_ttl_minutes` (default 30). Set to 0 to disable. Cache is checked before any fetch or LLM call. Expired entries are ignored on read, not auto-deleted.

## Audit and feedback

Every LLM match (cache miss) is logged to `match_log` with:
- Page classification (category, topics, description)
- Candidate set metadata (count, IDs, pre-score cutoff)
- Full LLM response and final match results

Users can record feedback via `match --feedback` and diagnose failures via `match --diagnose`. See DATABASE.md for table schemas.

### Diagnostic root causes

`match --diagnose` identifies three failure modes:
1. **CANDIDATE_SELECTION** — the expected group wasn't in the candidate set (pre-score too low)
2. **LLM_RANKING** — the group was sent to the LLM but wasn't selected as a match
3. **LLM_SCORE** — the group was matched but scored lower than expected

## Configuration

All match settings live in `fetch.config.toml` under `[match]`:

| Key | Default | Description |
|-----|---------|-------------|
| `max_groups_in_prompt` | 30 | Number of pre-scored candidates to send to LLM |
| `max_page_bytes` | 20,000 | Max page content sent to LLM |
| `cache_ttl_minutes` | 30 | Match cache TTL (0 = disabled) |
| `system_prompt` | (built-in) | LLM system prompt for matching |

The LLM model is shared from `[openrouter].model`.

## CLI reference

```
bookmark-index match <url> [hint] [--json] [--top N] [--strategy NAME] [--no-prescore] [--no-cache] [--verbose]
bookmark-index match --feedback <url> --expected <group> [--type wrong_match|missing_match|correct|note] [--notes "..."]
bookmark-index match --audit [--json] [--has-feedback] [--wrong-only]
bookmark-index match --diagnose <url> [--json]
```

| Flag | Description |
|------|-------------|
| `--strategy NAME` | Match strategy to use (default: `llm-fetch`) |
| `--no-prescore` | Skip local pre-scoring, use arbitrary group ordering (for A/B comparison) |
| `--no-cache` | Skip the match cache and force a fresh match |
| `--top N` | Show top N matches (default: 5) |
