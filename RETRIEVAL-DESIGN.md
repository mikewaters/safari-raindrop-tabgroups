# Retrieval Design

## Phase 2 Scope

This repository now includes the first retrieval-oriented layer for Collection Card matching.

- `bookmark-index enrich` builds per-item signal packs and collection-level representations
- `card-match` uses vector scoring when collection representations exist
- `card-match` falls back to lexical scoring when a group has not been enriched yet
- `match_log` records ambiguity metadata for fresh matches

## Embedding Model

The current alpha build uses a lazy-loaded local embedding model.

- Model identifier: `local-minilm-l6-v2`
- Backing model: `Xenova/all-MiniLM-L6-v2`
- Configurable through `[enrich].embedding_model_version`
- Configurable vector size through `[enrich].vector_dimensions` (default `384`)

The model is loaded once on first use and then reused for later `enrich` and `match` calls in the same process. This keeps match latency close to the existing fetch/extraction cost after the first load.

## Enrichment Pipeline

For each item in a group:

1. Normalize the URL
2. Build a signal-pack text from the item title, hostname, and path segments
3. Extract keyphrases and lightweight entity hints
4. Generate a local embedding vector
5. Persist the derived fields back to `items`

For each group:

1. Load all item embeddings for the group
2. Compute a normalized centroid vector
3. Select the nearest vectors to the centroid as exemplars
4. Persist the collection representation in `collection_representations`

## Matching Behavior

`card-match` computes a query embedding from the fetched page signal pack.

If a group has a matching collection representation:

```text
s_centroid = dot(url_vec, centroid_vec)
s_exemplar = max(dot(url_vec, exemplar_vec_i))
score = 0.6*s_exemplar + 0.4*s_centroid
```

If not, the matcher falls back to the lexical Collection Card score from Phase 1.

## Ambiguity

Fresh matches compute:

- `top1_margin`
- `topk_entropy`
- `is_ambiguous`

Thresholds are configured under `[match]` in `fetch.config.toml`.
