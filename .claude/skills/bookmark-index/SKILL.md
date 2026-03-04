---
name: bookmark-index
description: Generate Collection Classification for Safari tab groups and Raindrop collections using the bookmark-index CLI
triggers:
  - classify tab groups
  - classify bookmarks
---

# bookmark-index classification generation

You are generating **classification Cards** — structured semantic identities for browser tab groups and Raindrop collections stored in the `bookmark-index` database. Each card captures what a collection represents, enabling disambiguation between overlapping topics and accurate URL-to-collection matching.

You ARE the LLM — you do not need OpenRouter or any external API. You generate cards directly and import them via `classify --import`.

## Workflow

### 1. Read the Collection Card reference

Read `references/classify.md` (relative to this skill) for:
- The system prompt and categories
- The expected output JSON schema
- Guidance on writing effective cards that disambiguate overlapping collections

### 2. Get a page of unclassified collections

```sh
bookmark-index list unclassified --limit 10 --json
```

Returns `{ total, offset, limit, rows }`. The `total` field tells you how many unclassified collections remain. Use `--offset N` to page through them. Filter by source with `--safari` or `--raindrop`.

### 3. Get full detail for each collection in the page

```sh
bookmark-index show "<collection name>" --json
```

Returns the collection's tabs (titles + URLs), existing card (if any), version info, and author. Use this data to build the Collection Card.

### 4. Generate Collection Cards for the page

For each collection, consider the collection name, tab titles, and URLs. Apply the system prompt and categories from the reference to produce a Collection Card JSON object.

### 5. Store the batch

Note: make sure you use your own model name in the `--author` field.

```sh
echo '<object keyed by collection name>' | bookmark-index classify --import --all --author "$your_model_name"
```

The batch format is:
```json
{
  "Group A": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.9 },
  "Group B": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.8 }
}
```

### 6. Repeat

After importing a batch, loop back to step 2 to get the next page.

**Important: Do NOT delegate classification to subagents.** The `bookmark-index` CLI writes to a local SQLite database. Subagents spawned via the Agent tool may run in isolated worktrees with a separate copy of the database, causing their imports to silently disappear. Always run `bookmark-index show` and `bookmark-index classify --import` directly from the main session.

## Notes

- The CLI validates imported cards — invalid entries are warned and skipped
- Importing creates a **new version** of the classification (previous versions are preserved)
- Use `--author "model-name"` to distinguish agent-generated cards from other sources
- Filter with `--safari` or `--raindrop` to focus on one source
