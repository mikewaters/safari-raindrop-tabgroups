# Implementation Roadmap

## Status

Phase 1 and Phase 2 are implemented in this repository.
Phase 3 is now active with the first governance loop in place.

- Implement Collection Card storage and versioning in `bookmark-index`
- Make `card-match` the default URL matcher
- Keep `llm-fetch` as an opt-in secondary matcher
- Treat the database schema as alpha and reset-only

## Alpha Reset Policy

- No schema migrations are provided.
- Older database files are unsupported after a breaking schema change.
- If `bookmark-index` reports an unsupported schema, delete the DB file and rerun `bookmark-index update`.

## Phase 1: CLI Foundation

Delivered or targeted in this phase:

- `describe-tabgroup` emits Collection Card JSON
- `bookmark-index classify` generates or imports Collection Cards
- `bookmark-index version` manages Collection Card versions
- `bookmark-index match` defaults to `card-match`
- `bookmark-index match` returns up to 10 results by default
- match audit logs store page signal excerpts and derived keyphrases

Collection Card payload:

```json
{
  "definition": "string",
  "includes": ["string"],
  "excludes": ["string"],
  "keyphrases": ["string"],
  "representative_entities": ["string"]
}
```

## Phase 2: Retrieval And Offline Enrichment

Delivered or targeted in this phase:

- Add `bookmark-index enrich`
- Persist item-level signal packs, keyphrases, entities, and embeddings
- Add collection-level centroids and exemplars
- Upgrade `card-match` to embedding-based scoring with lexical fallback
- Add ambiguity metadata to match logs

Design notes for this phase live in `RETRIEVAL-DESIGN.md`.

## Phase 3: Governance And Quality Controls

Delivered or active:

- Add `bookmark-index review`
- Add `bookmark-index metrics`
- Add drift detection and review queues
- Add operator artifacts for golden-set and operations workflows
- Preserve manual Collection Card versions as authoritative until explicitly replaced

## Phase 4: Productization

Planned:

- Extract shared matching logic into reusable modules
- Add realtime inference and offline worker wrappers
- Add dashboard-facing metrics or APIs
- Add operational controls such as auth, rate limiting, and monitored latency budgets
