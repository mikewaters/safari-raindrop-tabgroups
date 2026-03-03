---
name: bookmark-index
description: Generate Collection Cards for Safari tab groups and Raindrop collections using the bookmark-index CLI
triggers:
  - classify tab groups
  - classify bookmarks
  - bookmark classification
  - tab group classification
  - collection card
  - generate collection cards
---

# bookmark-index Collection Card generation

You are generating **Collection Cards** — structured semantic identities for browser tab groups and Raindrop collections stored in the `bookmark-index` database. Each card captures what a collection represents, enabling disambiguation between overlapping topics and accurate URL-to-collection matching.

You ARE the LLM — you do not need OpenRouter or any external API. You generate cards directly and import them via `classify --import`.

## Workflow

### 1. Identify groups needing classification

```sh
bun run index list --json
```

Returns all groups. Groups with `active_version: null` have no Collection Card yet. Filter by source with `--safari` or `--raindrop`.

### 2. Get full detail for groups you need to classify

```sh
bun run index show "<group name>" --json
```

Returns the group's tabs (titles + URLs), existing classification (if any), version info, and author. Use this data to build the Collection Card.

### 3. Read the Collection Card reference

Read `references/classify.md` (relative to this skill) for:
- The system prompt and categories
- The expected output JSON schema
- Guidance on writing effective cards that disambiguate overlapping collections

### 4. Generate each Collection Card

For each group, consider the group name, tab titles, and URLs. Apply the system prompt and categories from the reference to produce a Collection Card JSON object.

### 5. Store results

**Single group:**
```sh
echo '<card JSON>' | bun run index classify --import "<group name>" --author "claude"
```

**Multiple groups (batch, recommended):**
```sh
echo '<object keyed by group name>' | bun run index classify --import --all --author "claude"
```

The batch format is:
```json
{
  "Group A": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.9 },
  "Group B": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.8 }
}
```

Batch 10-20 groups at a time for efficiency.

## Notes

- All commands run from the `safari-tabgroups` project root
- The CLI validates imported cards — invalid entries are warned and skipped
- Importing creates a **new version** of the classification (previous versions are preserved)
- Use `--author "claude"` to distinguish agent-generated cards from other sources
- Filter `list` output with `--safari` or `--raindrop` to focus on one source
