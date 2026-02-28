# SafariTabs.db Schema Reference

This document describes the full schema and embedded plist structures found in Safari's `SafariTabs.db` SQLite database. It is intended as a reference for future feature work on the safari-tabgroups tool.

## Summary

Safari stores all tab group, tab, window, and profile state in a single SQLite database at:

- Safari: `~/Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db`
- Safari Technology Preview: `~/Library/Containers/com.apple.SafariTechnologyPreview/Data/Library/SafariTechnologyPreview/SafariTabs.db`

The database uses WAL (Write-Ahead Logging) mode. Recent writes may only be present in the `-wal` file until Safari performs a checkpoint.

### What we currently use

The tool queries only the `bookmarks` table, using these columns: `id`, `title`, `url`, `parent`, `type`, `subtype`, `num_children`, `hidden`, `order_index`.

### What we don't use

- **Plist blobs** in `extra_attributes` and `local_attributes` containing timestamps, device info, tab state, and session history
- **Window state** tables (`windows`, `windows_tab_groups`, `windows_profiles`) tracking which tab groups are open in which windows and which tab is active
- **Sync metadata** tables (`sync_properties`, `participant_presence`, `generations`)
- Several unused scalar columns on `bookmarks` (`date_closed`, `last_modified`, `read`, `icon`, `cookies_uuid`, `session_storage_uuid`, `external_uuid`)

---

## Tables

### `bookmarks` (primary table)

The central table. Stores profiles, tab groups, and individual tabs in a hierarchical parent-child structure.

#### Columns

| Column | Type | Description | Populated? |
|--------|------|-------------|------------|
| `id` | INTEGER PK | Auto-incrementing row ID | Always |
| `special_id` | INTEGER | Internal Safari identifier for special folders | Sparse |
| `parent` | INTEGER | FK to parent `bookmarks.id`. `0` = top-level | Always |
| `type` | INTEGER | Row type: `1` = folder/group, `0` = leaf/tab | Always |
| `subtype` | INTEGER | `0` = normal, `2` = profile | Always |
| `title` | TEXT | Tab page title or tab group name | Always |
| `url` | TEXT | Tab URL (null for folders/groups) | Tabs only |
| `num_children` | INTEGER | Number of child rows | Always |
| `editable` | INTEGER | Whether the entry can be edited | Always |
| `deletable` | INTEGER | Whether the entry can be deleted | Always |
| `hidden` | INTEGER | `1` = hidden from UI | Always |
| `hidden_ancestor_count` | INTEGER | Count of hidden ancestors | Always |
| `order_index` | INTEGER | Sort position within parent | Always |
| `external_uuid` | TEXT | UUID for sync identification | All rows (2002/2002) |
| `read` | INTEGER | Read status | Never populated (0/2002) |
| `last_modified` | REAL | Modification timestamp | Never populated (0/2002) |
| `date_closed` | REAL | When the tab was closed | Never populated (0/2002) |
| `last_selected_child` | INTEGER | FK to last selected child bookmark | Sparse |
| `server_id` | TEXT | iCloud sync server ID | Sparse |
| `sync_key` | TEXT | iCloud sync key | Sparse |
| `sync_data` | BLOB | iCloud sync payload | Sparse |
| `added` | INTEGER | Whether this was locally added | Always |
| `deleted` | INTEGER | Soft-delete flag | Always |
| `extra_attributes` | BLOB | Binary plist (see below) | 1761/2002 rows |
| `local_attributes` | BLOB | Binary plist (see below) | 1372/2002 rows |
| `fetched_icon` | BOOL | Whether favicon has been fetched | Always |
| `icon` | BLOB | Favicon data | Never populated (0/2002) |
| `dav_generation` | INTEGER | DAV sync generation counter | Always |
| `locally_added` | BOOL | Added on this device | Always |
| `archive_status` | INTEGER | Archival status | Always |
| `syncable` | BOOL | Whether this syncs to iCloud | Always |
| `web_filter_status` | INTEGER | Content filter status | Always |
| `modified_attributes` | UNSIGNED BIG INT | Bitmask of modified fields | Always |
| `cookies_uuid` | TEXT | Per-tab cookie container UUID | 249/2002 rows |
| `local_storage_uuid` | TEXT | Per-tab local storage UUID | 0/2002 rows |
| `session_storage_uuid` | TEXT | Per-tab session storage UUID | 213/2002 rows |

#### Row hierarchy

```
parent=0, type=1, subtype=0  → Personal profile tab groups
parent=0, subtype=2          → Additional profile definitions
parent=<profile_id>, subtype=0, num_children>0 → Tab groups within a profile
parent=<group_id>            → Individual tabs within a tab group
```

Note: `date_closed`, `last_modified`, `read`, and `icon` are defined on the schema but were empty across all 2002 rows in the sampled database. The equivalent data lives in the plist blobs instead (see below).

---

### `extra_attributes` plist (on `bookmarks`)

Binary plist blob. Can be decoded with `plutil -convert json -o - -- -` (or xml1 for date types). The structure varies by row type.

#### On tab groups (type=1, parent=0 or parent=profile_id)

```xml
<dict>
    <key>com.apple.Bookmark</key>
    <dict>
        <key>DateAdded</key>
        <date>2026-02-22T17:08:28Z</date>   <!-- when the tab group was created -->
    </dict>
</dict>
```

Some tab groups also have:

```xml
<dict>
    <key>com.apple.bookmarks.OmitFromUI</key>
    <true/>    <!-- hidden from the Safari UI -->
</dict>
```

#### On tabs (rows with url)

```xml
<dict>
    <key>DateLastViewed</key>
    <date>2026-02-28T00:04:46Z</date>     <!-- last time this tab was viewed -->

    <key>DeviceIdentifier</key>
    <string>E003CC7C-80DB-4C2A-9045-131C69DACD10</string>  <!-- UUID of the device that last viewed this tab -->

    <key>LocalTitle</key>
    <string>Page Title</string>           <!-- locally-observed page title (may differ from bookmarks.title) -->

    <key>LocalURL</key>
    <string>https://example.com</string>  <!-- locally-observed URL (may differ from bookmarks.url after redirects) -->

    <key>ReadStatusGeneration</key>
    <integer>4</integer>                  <!-- sync generation for read status -->

    <key>com.apple.Bookmark</key>
    <dict>
        <key>DateAdded</key>
        <date>2026-02-27T23:23:06Z</date> <!-- when this tab entry was created -->
    </dict>
</dict>
```

**Key insight**: `LocalURL` and `LocalTitle` may differ from the top-level `bookmarks.url` and `bookmarks.title`. The `Local*` variants reflect what the device actually loaded (e.g., after redirects or SPA navigation), while the top-level fields reflect the synced/canonical values.

#### On profiles (subtype=2)

```xml
<dict>
    <key>BackgroundImageModifiedState</key>
    <integer>1</integer>

    <key>SymbolImageName</key>
    <string>person.fill</string>   <!-- SF Symbol name for the profile icon -->
</dict>
```

---

### `local_attributes` plist (on `bookmarks`)

Binary plist blob. Only present on tab rows (rows with a URL). Not present on folder/group rows. Contains per-tab state that is local to this device.

Present on 1356 of 1585 tab rows (some older tabs lack it).

```xml
<dict>
    <!-- Tab lineage: UUIDs of ancestor tabs that led to opening this tab -->
    <key>AncestorTabUUIDsKey</key>
    <array>
        <string>501B60EC-B019-46F3-A64B-7303251C4B45</string>
    </array>
    <!-- Empty array means this tab was opened directly (not from a link) -->

    <!-- When the tab was closed (moved out of active tabs) -->
    <key>DateClosed</key>
    <date>2026-02-27T23:23:57Z</date>

    <!-- Whether the tab is displaying a standalone image (e.g., opened an image URL directly) -->
    <key>DisplayingStandaloneImage</key>
    <false/>

    <!-- Ephemeral tab that Safari may discard -->
    <key>IsDisposable</key>
    <false/>

    <!-- Whether audio is muted on this tab -->
    <key>IsMuted</key>
    <false/>

    <!-- Last time this tab was actively visited/focused -->
    <key>LastVisitTime</key>
    <date>2026-02-28T00:04:46Z</date>

    <!-- Whether this tab was opened by clicking a link (vs. typed URL, bookmark, etc.) -->
    <key>OpenedFromLink</key>
    <false/>

    <!-- Reader mode scroll position -->
    <key>ReaderViewTopScrollOffset</key>
    <real>0.0</real>

    <!-- Associated Reading List bookmark ID (0 = none) -->
    <key>ReadingListBookmarkID</key>
    <integer>0</integer>

    <!-- Whether this tab is safe to reload/restore -->
    <key>SafeToLoad</key>
    <true/>

    <!-- Nested binary blob containing WebKit session/navigation history -->
    <key>SessionState</key>
    <data>...</data>
    <!-- Contains: back/forward history entries, each with URL, title, and form state.
         This is a WebKit serialization format, not a standard plist. -->

    <!-- Whether Reader mode is active -->
    <key>ShowingReader</key>
    <false/>

    <!-- Tab's position index in the window -->
    <key>TabIndex</key>
    <integer>28</integer>

    <!-- UUID of the window containing this tab -->
    <key>WindowUUID</key>
    <string>8FCA4D13-F794-4375-9A87-092C2CEEA344</string>

    <!-- Schema version for this plist structure -->
    <key>version</key>
    <integer>1</integer>
</dict>
```

---

### `windows`

Tracks Safari windows and their state.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Window ID |
| `active_tab_group_id` | INTEGER | FK to `bookmarks.id` — currently displayed tab group |
| `date_closed` | REAL | When the window was closed |
| `extra_attributes` | BLOB | Binary plist with window geometry, sidebar state, etc. |
| `is_last_session` | INTEGER | Whether this window is from the last session |
| `local_tab_group_id` | INTEGER | FK to `bookmarks.id` — local/unnamed tab group |
| `private_tab_group_id` | INTEGER | FK to `bookmarks.id` — private browsing tab group |
| `scene_id` | TEXT | macOS scene identifier |
| `uuid` | TEXT | Unique window identifier |
| `active_profile_id` | INTEGER | FK to `bookmarks.id` — active profile in this window |
| `restoration_archive` | BLOB | Binary archive for window restoration |

#### `windows.extra_attributes` plist

Contains window UI state (decoded from binary plist embedded in the row). Key fields observed:

- `uuid` — window UUID
- `SelectedTabIndex` — index of the selected tab
- `WindowUnifiedSidebarMode` — sidebar visibility
- `TabBarHidden` — whether the tab bar is hidden
- `DateClosed` — closure timestamp
- `TabGroupsToActiveTabs` — mapping of tab group IDs to their active tab
- `FavoritesBarHidden` — favorites bar visibility
- `IsPopupWindow` — whether this is a popup
- `ProfileUUID` — UUID of the active profile
- `WindowContentRect` — window position and size as a string
- `IsPrivateWindow` — private browsing flag
- `SelectedPinnedTabIndex` — selected pinned tab
- `activeTabGroupUUID` — UUID of the active tab group
- `UnnamedTabGroupUUIDs` — UUIDs of unnamed tab groups

---

### `windows_tab_groups`

Maps tab groups to windows. Indicates which tab is active in each group.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `active_tab_id` | INTEGER | FK to `bookmarks.id` — the currently selected tab in this group |
| `tab_group_id` | INTEGER | FK to `bookmarks.id` — the tab group |
| `window_id` | INTEGER | FK to `windows.id` — the containing window |

**Unique constraint**: `(tab_group_id, window_id)` — a tab group appears at most once per window.

This is the table to use for determining which tab is currently active/selected within a given tab group.

---

### `windows_profiles`

Maps profiles to windows.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `active_tab_group_id` | INTEGER | FK to `bookmarks.id` — active tab group for this profile in this window |
| `profile_id` | INTEGER | FK to `bookmarks.id` — the profile |
| `window_id` | INTEGER | FK to `windows.id` — the window |

---

### `windows_unnamed_tab_groups`

Tracks unnamed/ephemeral tab groups per window.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `tab_group_id` | INTEGER | FK to `bookmarks.id` |
| `window_id` | INTEGER | FK to `windows.id` |

---

### `folder_ancestors`

Precomputed ancestor chain for folder hierarchy traversal.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `folder_id` | INTEGER | FK to `bookmarks.id` — the folder |
| `ancestor_id` | INTEGER | FK to `bookmarks.id` — an ancestor (`0` = root) |

---

### `session_state`

Per-tab WebKit session data, keyed by UUID.

| Column | Type | Description |
|--------|------|-------------|
| `uuid` | TEXT PK | Tab UUID |
| `data` | BLOB | WebKit session serialization (back/forward history, form data, scroll position) |

---

### `settings`

Profile-level settings (e.g., profile color).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `key` | TEXT | Setting name (e.g., `ProfileColor`) |
| `value` | NUMERIC/BLOB | Setting value (often a binary plist containing an NSKeyedArchiver payload) |
| `generation` | INTEGER | Sync generation |
| `device_identifier` | TEXT | Device UUID |
| `parent` | INTEGER | FK to `bookmarks.id` (profile) — NULL means default profile |

---

### `generations`

Single-row table tracking the current sync generation number.

| Column | Type | Description |
|--------|------|-------------|
| `generation` | INTEGER | Current generation counter |

---

### `sync_properties`

Key-value store for iCloud sync metadata.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT | Property name |
| `value` | TEXT | Property value |

Known keys: `_dav_generation`, `AccountHash`, `BASyncData`, `_ck_local_migration_state_*`, `newestLaunchedSafariVersion`.

---

### `participant_presence`

Tracks iCloud Shared Tab Groups participant presence (collaborative browsing).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Row ID |
| `participant_id` | TEXT | Participant identifier |
| `tab_group_server_id` | TEXT | Server ID of the shared tab group |
| `tab_server_id` | TEXT | Server ID of the tab being viewed |

---

### `bookmark_title_words`

Full-text search index for bookmark titles. Automatically maintained via trigger on `bookmarks` delete.

---

## Parsing plist blobs

macOS ships with `plutil` which can convert binary plists:

```sh
# Extract a blob and convert to JSON (fails on date types)
sqlite3 SafariTabs.db "SELECT hex(extra_attributes) FROM bookmarks WHERE id=123;" \
  | xxd -r -p | plutil -convert json -o - -- -

# Convert to XML (handles all types including dates)
sqlite3 SafariTabs.db "SELECT hex(extra_attributes) FROM bookmarks WHERE id=123;" \
  | xxd -r -p | plutil -convert xml1 -o - -- -
```

Note: `plutil -convert json` fails on plists containing `<date>` values (Apple's JSON format doesn't support dates). Use `xml1` format for reliable parsing of all types.

For programmatic access from TypeScript/Bun, options include:
- Shell out to `plutil` via `Bun.spawn`
- Use a JavaScript binary plist parser library (e.g., `bplist-parser`)
- Write a custom parser for the subset of plist types we need

## Future feature ideas

- **Active tab indicator**: Use `windows_tab_groups.active_tab_id` to mark which tab is currently selected in each group
- **Tab timestamps**: Parse `DateLastViewed` from `extra_attributes` and `LastVisitTime` from `local_attributes`
- **Tab creation date**: Parse `com.apple.Bookmark.DateAdded` from `extra_attributes`
- **Tab lineage**: Parse `AncestorTabUUIDsKey` from `local_attributes` to show tab-opened-from-tab relationships
- **Window awareness**: Show which window(s) a tab group is open in
- **Muted tabs**: Parse `IsMuted` from `local_attributes`
- **Profile icons**: Parse `SymbolImageName` from profile `extra_attributes`
- **Reader mode tabs**: Parse `ShowingReader` from `local_attributes`
- **Stale tab detection**: Compare `LastVisitTime` to find tabs not visited in a long time
