# Match Logic

The `bookmark-index match` command finds which stored groups best fit a given URL. Matching is handled by pluggable strategies selected with `--strategy NAME`.

Default strategy: `card-match`

## Strategy Architecture

Strategies implement `MatchStrategy` in `src/match/types.ts`:

```ts
interface MatchStrategy {
  name: string;
  match(params: MatchParams): Promise<MatchResult>;
}
```

Strategies receive the URL, DB handle, config, current Collection Cards, and runtime flags. They return ranked matches plus audit metadata. Cache handling, audit logging, and output formatting stay in `src/index.ts`.

## Available Strategies

| Name | File | Description |
|------|------|-------------|
| `card-match` | `src/match/card-match.ts` | Vector scoring with lexical fallback over Collection Card fields |
| `llm-fetch` | `src/match/llm-fetch.ts` | LLM-assisted matching using Collection Card context |

## `card-match`

Phase 2 keeps the lexical signal pack from Phase 1:

- hostname
- path segments
- title
- first two markdown headings
- filtered body excerpt
- derived keyword set

When `bookmark-index enrich` has built retrieval data, `card-match` uses the collection representation:

- `s_centroid = dot(url_vec, centroid_vec)`
- `s_exemplar = max(dot(url_vec, exemplar_vec_i))`
- `score = 0.6*s_exemplar + 0.4*s_centroid`

If a group has no collection representation, the matcher falls back to the Phase 1 lexical score:

```text
score = clamp(0.0, 1.0,
  0.35*s_definition +
  0.30*s_keyphrases +
  0.20*s_includes +
  0.15*s_domain -
  0.25*s_excludes
)
```

Results are re-sorted after a recency boost based on the group’s `last_active` timestamp.
Fresh matches also compute ambiguity metadata:

- top-1 margin
- top-k softmax entropy
- ambiguous/not-ambiguous flag

The default Phase 3 embedding backend is a lazy-loaded local MiniLM model (`local-minilm-l6-v2`). The first embedding request loads the model into process memory; later `match` calls reuse that singleton.

## `llm-fetch`

`llm-fetch` still performs:

1. fetch page markdown
2. locally pre-score Collection Cards
3. send the top candidates to OpenRouter
4. apply recency boost to returned scores

Unlike the legacy implementation, it does not return a page classification. It returns only ranked matches:

```json
{
  "matches": [
    {
      "group": "My Group",
      "source": "safari",
      "score": 0.82,
      "reason": "Strong overlap with the card definition and keyphrases."
    }
  ]
}
```

## Cache And Audit

- `match_cache` stores `{ classification: null, matches: [...] }`
- `match_log` stores the page signal excerpt, derived page keyphrases, candidate metadata, strategy name, model, raw matcher response, final ranked matches, and ambiguity metadata
- `match_feedback` stores user corrections and notes
- `collection_review_queue` stores collections flagged by drift, confusion, or sustained ambiguity

## CLI Reference

```bash
bookmark-index match <url> [hint] [--json] [--top N] [--strategy NAME] [--no-prescore] [--no-cache] [--verbose]
bookmark-index match --feedback <url> --expected <group> [--type wrong_match|missing_match|correct|note] [--notes "..."]
bookmark-index match --audit [--json] [--has-feedback] [--wrong-only]
bookmark-index match --diagnose <url> [--json]
```

Defaults:

- `--top 10`
- `--strategy card-match`
