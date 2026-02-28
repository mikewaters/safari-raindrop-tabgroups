# safari-tabgroups

Enumerate Safari Tab Groups (and their tabs) from the local `SafariTabs.db` database.

## Install

Requires [Bun](https://bun.sh).

```sh
make install          # builds + copies to /usr/local/bin
# or install elsewhere:
PREFIX=~/.local/bin make install
```

## Usage

```
safari-tabgroups [--stp] [--json] [--cached] [--verbose] [--debug]
```

| Flag | Description |
|------|-------------|
| `--stp` | Target Safari Technology Preview instead of Safari |
| `--json` | Output as JSON instead of flat text |
| `--cached` | Skip copying the database; read from the last cached copy |
| `--verbose` | Verbose logging to stderr |
| `--debug` | Same as `--verbose`, plus writes the cache copy to cwd instead of `$XDG_CACHE_HOME` |

### Examples

```sh
# List all tab groups (flat text)
safari-tabgroups

# JSON output
safari-tabgroups --json

# Use cached database (faster, no disk copy)
safari-tabgroups --cached

# Safari Technology Preview
safari-tabgroups --stp

# Pipe JSON to jq
safari-tabgroups --json | jq '.profiles[].tabGroups[].name'
```

### Output format

**Text (default):** one line per tab as `Profile / Tab Group / Title (URL)`

```
Personal / Research / Some Page (https://example.com)
Personal / Work / Jira Board (https://jira.example.com)
```

**JSON (`--json`):**

```json
{
  "profiles": [
    {
      "name": "Personal",
      "tabGroups": [
        {
          "name": "Research",
          "tabs": [
            { "title": "Some Page", "url": "https://example.com" }
          ]
        }
      ]
    }
  ]
}
```

## How it works

1. Copies Safari's `SafariTabs.db` (plus WAL/SHM files) to `$XDG_CACHE_HOME/safari-tabgroups/` (default `~/.cache/safari-tabgroups/`). Skips the copy if the cache is already up to date.
2. Queries the `bookmarks` table to discover profiles, tab groups, and tabs.
3. Outputs the results to stdout.

The database is never read in-place -- always from a cached copy.

## Development

```sh
bun install           # install dev dependencies
bun run src/index.ts  # run from source
make build            # compile standalone binary
make clean            # remove compiled binary
```
