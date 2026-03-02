---
name: bookmark-index
description: Classify Safari tab groups and Raindrop collections using the bookmark-index CLI
triggers:
  - classify tab groups
  - classify bookmarks
  - bookmark classification
  - tab group classification
---

# bookmark-index classify

You are classifying browser tab groups and Raindrop collections stored in the `bookmark-index` database. You ARE the LLM — you do not need OpenRouter or any external API. You classify directly and import results via `--import`.

## Workflow

### 1. List groups and their classification status

```sh
bun run index list --json
```

This returns all groups with their `classified_at` status. Groups with `classified_at: null` have not been classified yet.

### 2. Get full detail for groups you need to classify

```sh
bun run index show "<group name>" --json
```

This returns the group's tabs (titles + URLs) and any existing classification. Use this data to build your classification.

### 3. Read the classification reference

Read `references/classify.md` (relative to this skill) for:
- The system prompt and categories
- The expected output JSON schema
- The user message format

### 4. Classify each group

For each group, consider the group name, tab titles, and URLs. Apply the system prompt and categories from the reference to produce a classification JSON object.

### 5. Store results

**Single group:**
```sh
echo '<classification JSON>' | bun run index classify --import "<group name>"
```

**Multiple groups (batch):**
```sh
echo '<object keyed by group name>' | bun run index classify --import --all
```

The batch format is:
```json
{
  "Group A": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.9 },
  "Group B": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.8 }
}
```

## Notes

- All commands run from the `safari-tabgroups` project root
- The CLI validates imported classifications — invalid entries are warned and skipped
- Use `--all` with `list` to see every group, or filter with `--safari` / `--raindrop`
- Re-importing for a group overwrites its previous classification
