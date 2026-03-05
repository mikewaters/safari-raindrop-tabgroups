---
name: bookmark-index
description: Generate Collection Classification for Safari tab groups and Raindrop collections using the bookmark-index CLI
triggers:
  - classify tab groups
  - classify bookmarks
---

# bookmark-index classification generation

You are generating **Classification Cards** — structured semantic identities for browser tab groups and Raindrop collections stored in the `bookmark-index` database. Each card captures what a collection represents, enabling disambiguation between overlapping topics and accurate URL-to-collection matching.

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

### 4. Fetch page content for richer classification

For each collection, fetch page content from a sample of its URLs to produce a richer, more accurate card. This also captures a **page snapshot** that is stored alongside the card.

**Rules:**
- Fetch up to **3 URLs** per collection (prioritize URLs whose titles are ambiguous or generic)
- **Skip** URLs on these domains: `discord.com`, `localhost`, any `.ts.net` domain
- **Truncate** each page's content to **500 bytes** (enough for a summary, not a full article)
- Use the `WebFetch` tool to retrieve each URL

**Assemble the snapshot:**

Concatenate the fetched content into a single markdown string:

```
## Tab Title 1
<truncated page content>

## Tab Title 2
<truncated page content>
```

Store this string as the `page_snapshot` field in the card JSON. If no pages could be fetched (all failed or were skipped), omit `page_snapshot`.

Use both the tab metadata (titles, URLs) AND the fetched page content to generate the card fields.

### 5. Generate Collection Cards for the page

For each collection, consider the collection name, tab titles, URLs, and fetched page content. Apply the system prompt and categories from the reference to produce a Collection Card JSON object.

### 6. Store the batch

Note: make sure you use your own model name in the `--author` field.

```sh
echo '<object keyed by collection name>' | bookmark-index classify --import --all --author "$your_model_name"
```

The batch format is:
```json
{
  "Group A": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.9, "page_snapshot": "## Title\ncontent..." },
  "Group B": { "description": "...", "category": "...", "topics": [...], "intent": "...", "confidence": 0.8 }
}
```

The `page_snapshot` field is optional — include it when pages were successfully fetched, omit it otherwise.

### 7. Repeat

After importing a batch, loop back to step 2 to get the next page.

**Important: Do NOT delegate classification to subagents.** The `bookmark-index` CLI writes to a local SQLite database. Subagents spawned via the Agent tool may run in isolated worktrees with a separate copy of the database, causing their imports to silently disappear. Always run `bookmark-index show` and `bookmark-index classify --import` directly from the main session.

## Notes

- The CLI validates imported cards — invalid entries are warned and skipped
- Importing creates a **new version** of the classification (previous versions are preserved)
- Use `--author "model-name"` to distinguish agent-generated cards from other sources
- Filter with `--safari` or `--raindrop` to focus on one source
- `page_snapshot` is stored in the `group_classifications` table and shown by `bookmark-index show`
