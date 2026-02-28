### Technical requirements: Enumerate Safari Tab Groups (and their tabs) via SafariTabs.db

#### 1. Inputs / CLI behavior
- The tool MUST accept an optional flag `--stp` to target Safari Technology Preview instead of Safari.
- The tool MUST accept an optional flag `--debug` to toggle DEBUG MODE.
- The tool MUST accept an optional flag `--json` to denote structured output in JSON MODE.

#### 2. Safari data location
- If `-stp` is NOT present, the tool MUST use the Safari container path:
  - `~/Library/Containers/com.apple.Safari/Data/Library/Safari`
- If `-stp` IS present, the tool MUST use the Safari Technology Preview container path:
  - `~/Library/Containers/com.apple.SafariTechnologyPreview/Data/Library/SafariTechnologyPreview`
- The tool MUST treat `SafariTabs.db` located in the chosen container library as the source of truth:
  - `<library>/SafariTabs.db`

#### 3. Safe read strategy (non-destructive access)
- The tool MUST NOT read `SafariTabs.db` in-place.
- The tool MUST copy `SafariTabs.db` to a newly created temporary file before querying.
- The tool MUST open the SQLite database from the temporary copy.
- The tool MUST delete/unlink the temporary copy after export completes (whether export succeeds or fails), unless in DEBUG MODE.

#### 4. Database access requirements
- The tool MUST query the SQLite database using read-only operations.
- The tool MUST access the `bookmarks` table to enumerate:
  1) profiles (scopes), then
  2) tab groups (folders) per profile, then
  3) tabs/bookmarks within each tab group.

#### 5. Profile discovery requirements
- The tool MUST always include a “personal” (default) profile scope using the following selection criteria:
  - Select rows from `bookmarks` where:
    - `type = 1`
    - `parent = 0`
    - `subtype = 0`
    - `num_children > 0`
    - `hidden = 0`
  - The tool MUST sort these results by `id DESC`.
  - The tool MUST treat the resulting rows `(id, title)` as tab-group candidates within the personal profile.
- The tool MUST also discover additional profiles by selecting rows from `bookmarks` where:
  - `subtype = '2'`
  - `title != ''`
- For each discovered additional profile row `(profile_id, profile_title)`:
  - The tool MUST create a profile scope named from `profile_title` (normalized consistently; e.g., lowercased).
  - The tool MUST enumerate that profile’s tab groups by selecting rows from `bookmarks` where:
    - `parent = profile_id`
    - `subtype = 0`
    - `num_children > 0`
  - The tool MUST sort these tab-group results by `id DESC`.

#### 6. Tab group enumeration requirements
- For each profile scope (personal + discovered profiles), the tool MUST enumerate tab groups as rows of shape:
  - `(group_id, group_title)`
- The tool MUST preserve the profile scoping (i.e., tab groups MUST be associated with the profile they were discovered under).

#### 7. Tab (bookmark) enumeration requirements within a tab group
- For each tab group identified by `group_id`, the tool MUST enumerate the tabs/bookmarks by selecting:
  - `title, url`
  - From `bookmarks`
  - Where `parent = group_id`
  - And `title` MUST NOT be any of:
    - `TopScopedBookmarkList`
    - `Untitled`
    - `Start Page`
- The tool MUST order tabs within a group by:
  - `order_index ASC`
- The tool MUST treat each resulting row `(title, url)` as a tab entry within that tab group.

#### 8. Output structure requirements (for enumeration results)
- The tool MUST export outputs using the enumerated structure (profile → tab group → tabs) such that:
  - tab groups remain grouped under their profile
  - tabs remain grouped under their tab group
  - tab order within each group matches `order_index ASC`
- The tool's output should be sent to STDOUT
- Tool logs and error messages should be sent to STDERR.
- The tool's default output format is text.
- If the tool is in JSON MODE, it should emit a single JSON object containing all profile -> tab group -> tab information.

#### 9. Error handling / cleanup requirements
- The tool MUST close the SQLite connection after enumeration/export.
- The tool MUST ensure cleanup of temporary files even if an exception occurs during querying or export (e.g., via an ensure/finally mechanism), unless in DEBUG MODE.

#### 10. Debug option
When the `--debug` option is present, the tool is in DEBUG MODE.
- In DEBUG MODE, the temporary sqlite file should be created in the current working directory instead of a temp location. The filename should have a current timestamp to ensure no conflicts.
- In DEBUG MODE, the temporary sqlite file should not be deleted even in the case of error.
- In DEBUG MODE, the tool should emit verbose debug statements tracing through important code paths. Important code paths include file/directory operations, i/o, profiles read, and tab groups discovered.
