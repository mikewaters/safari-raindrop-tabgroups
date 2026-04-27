# Active Safari tab group detection

The Raycast `Show Tab Group` command needs to know which tab group the user is
currently looking at. This document explains how that detection works, why it
requires a specific Safari version, and what each failure mode looks like.

## What we detect

The **name of the tab group assigned to Safari's frontmost window**.

Safari has no global notion of "the active tab group" — the binding is
per-window. We always resolve relative to the front window of the frontmost
Safari process.

## How

Two AppleScript calls via `osascript`:

1. Confirm Safari is the frontmost app:
   ```applescript
   tell application "System Events"
       return name of first application process whose frontmost is true
   end tell
   ```

2. Read the active tab group:
   ```applescript
   tell application "Safari"
       if (count of windows) is 0 then return "__NO_WINDOW__"
       try
           set tg to current tab group of front window
           return name of tg
       on error
           return "__NO_TAB_GROUP__"
       end try
   end tell
   ```

The returned name is then matched against the local database via
`bookmark-index show-group --source safari --name "<name>" --json`.

## Why Safari 17+ is required

The `current tab group` property on a Safari `window` was **added in Safari 17
(macOS Sonoma)**. Earlier versions expose tabs and windows but have no scriptable
way to identify which tab group is currently selected.

We deliberately do *not* fall back to fingerprinting open tab URLs against the
`items` table on older Safari, because that match is ambiguous (groups can share
URLs, blank tabs match nothing, etc.) and would produce confusing UI.

## Failure modes

| Condition | AppleScript behavior | Raycast UX |
|---|---|---|
| Safari not frontmost | Step 1 returns a different app name | "Safari is not the frontmost app" |
| Safari frontmost, no windows | Returns `__NO_WINDOW__` | "No Safari window is open" |
| Window exists, no tab group active | Returns `__NO_TAB_GROUP__` (caught by inner `on error`) | "No tab group is active in the front Safari window" |
| Tab group name unknown to DB | `show-group` exits with `{"error":"not_found"}` | "Tab group … is not in your database. Run `bookmark-index update` first." |
| `osascript` itself fails | JS throws | "AppleScript failed: …" |

## Why not read SafariTabs.db directly

The cached SQLite mirror of Safari's data (`~/.cache/safari-tabgroups/SafariTabs.db`)
contains the *membership* of every tab group but not which one is currently
focused in the live UI. The focus state lives only in Safari's runtime, and
AppleScript is the only public way to read it.

## Source

Implementation: `raycast-extension/src/show-tab-group.tsx` (`getActiveSafariTabGroup`).
The URL-detection pattern in `raycast-extension/src/match-url.tsx` is analogous
but reads the active tab's URL rather than the window's tab group.
