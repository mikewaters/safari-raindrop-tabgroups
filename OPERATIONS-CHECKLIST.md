# Operations Checklist

Phase 3 adds a lightweight governance loop around Collection Cards and matching.

## Daily Or Before Large Matcher Changes

1. Run `bookmark-index update`.
2. Run `bookmark-index enrich --all`.
3. Check `bookmark-index review list`.
4. Inspect the highest-priority queued collections with `bookmark-index review show "<group>"`.
5. If a newer version exists, inspect `bookmark-index review diff "<group>"`.
6. Approve the active or replacement version with `bookmark-index review approve "<group>" [version]`.
7. Check `bookmark-index metrics`.

## When A Match Looks Wrong

1. Record feedback with `bookmark-index match --feedback <url> --expected "<group>"`.
2. Inspect the last run with `bookmark-index match --diagnose <url>`.
3. Re-run `bookmark-index enrich <group>` for the affected collection.
4. Review queue output to confirm the collection is flagged if drift persists.

## Alpha Reset Reminder

- There are no schema migrations.
- If the schema changes, delete the database file and rebuild it from source caches.
- Do not expect persisted review queue state to survive schema revisions during alpha.
