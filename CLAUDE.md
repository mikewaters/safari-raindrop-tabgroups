# safari-tabgroups

## Config file resolution

Config is resolved differently depending on how the tool is run:

- **`bun run`** (development): uses the project-root config file `fetch.config.toml`
- **Compiled binaries**: uses the user's config at `$XDG_CONFIG_HOME/safari-tabgroups/config.toml` (defaults to `~/.config/safari-tabgroups/config.toml`)

This logic lives in `src/config.ts` (`resolveConfigPath()`). The `make install` target copies `fetch.config.toml` to the XDG location if it doesn't already exist.

## Database path

The database path is resolved from the config file's `[database].path` field, defaulting to `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`. Environment variables (`$VAR`) and `~` are expanded. Can be overridden with `--db <path>`.
