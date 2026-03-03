# Golden Dataset

This file defines the operator workflow for the Phase 3 golden regression set.

## Purpose

The golden dataset is a curated list of URLs with expected Collection Card targets.
It is used to catch ranking regressions before changing:

- the local embedding model
- matching weights
- review thresholds
- Collection Card generation prompts

## Recommended Format

Use line-delimited JSON (`.jsonl`) stored outside the SQLite database:

```json
{"url":"https://platform.openai.com/docs/guides/agents","expected_group":"OpenAI / Agents","notes":"SDK docs"}
```

Required fields:

- `url`
- `expected_group`

Optional fields:

- `expected_source`
- `hint`
- `notes`

## Operating Procedure

1. Build or refresh the index with `bookmark-index update`.
2. Regenerate or refresh Collection Cards as needed.
3. Run `bookmark-index enrich --all`.
4. Sample candidate URLs that represent high-value collections and known edge cases.
5. Record the expected target collection for each URL.
6. Re-run the same set after any ranking or model change and compare top-1/top-5 outcomes with `bookmark-index metrics` and spot checks from `bookmark-index match --diagnose`.

## Coverage Guidance

Aim for roughly:

- 60% clear single-collection matches
- 25% ambiguous near-neighbor matches
- 15% known hard negatives or previously misclassified URLs

Keep at least 200 URLs before treating the dataset as a release gate.
