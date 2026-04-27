# Development

This document covers day-to-day development workflows: working on the CLI, the
Raycast extension, running tests, and shipping changes.

## Repo layout

```
safari-tabgroups/
├── src/                    # CLI sources (Bun + TypeScript)
├── test/                   # Bun test suite
├── raycast-extension/      # Raycast extension (separate npm project)
├── docs/                   # Design / mechanism docs
├── Makefile                # Build + install for the CLI binaries
└── fetch.config.toml       # Project-root config (used by `bun run …`)
```

## CLI development

The CLI is a set of Bun-compiled binaries (`bookmark-index`, `safari-sync`,
`raindrop-sync`, etc.) backed by shared modules in `src/`.

### Run from source

```bash
bun install
bun run index <subcommand> [flags]      # e.g. bun run index list
bun run safari-sync
bun run raindrop-sync
```

`bun run …` resolves config from the **project root** (`fetch.config.toml`). The
compiled binaries resolve config from `~/.config/safari-tabgroups/config.toml`
instead — see `src/config.ts` (`resolveConfigPath`) and
[CLAUDE.md](CLAUDE.md#config-file-resolution).

### Build + install the binaries

```bash
make build              # → ./dist/<binary>
make install            # → $HOME/.local/bin (override with PREFIX=…)
make uninstall          # leaves ~/.config/safari-tabgroups/config.toml in place
make clean
```

`make install` also seeds `~/.config/safari-tabgroups/config.toml` from
`fetch.config.toml` if it doesn't already exist. It does **not** overwrite an
existing config.

### Reset the local database

```bash
make cleandb            # removes bookmarks.db + WAL/SHM in cwd
```

The real database lives at `$XDG_DATA_HOME/safari-tabgroups/bookmarks.db`
(default: `~/.local/share/safari-tabgroups/bookmarks.db`). Pass `--db <path>` to
any subcommand to override.

## Tests

```bash
bun test                                # entire suite
bun test ./test/user-fields.test.ts     # single file (note: must be a path)
```

Tests use temp databases via `mkdtempSync` + `openDb` — they do not touch your
real `bookmarks.db`. Schema migrations run on every `openDb` call, so tests
exercise the migration path implicitly.

When adding a feature that touches schema or sync, add coverage in `test/` —
the `groups`-table soft-delete + `user_*` invariants in particular have a
test (`test/user-fields.test.ts`) that should be extended whenever sync paths
change.

## Raycast extension

Lives in `raycast-extension/`. Two commands:

- **Match URL** (`src/match-url.tsx`)
- **Show Tab Group** (`src/show-tab-group.tsx`) — see
  [docs/active-tab-group-detection.md](docs/active-tab-group-detection.md).

Both commands shell out to the `bookmark-index` binary, whose path is
configured via the extension's `binaryPath` preference (default
`~/.local/bin/bookmark-index`).

### Development mode

```bash
cd raycast-extension
npm install                              # first time only
npm run dev                              # wraps `ray develop`
```

`ray` is the Raycast CLI, shipped inside `@raycast/api` and installed at
`raycast-extension/node_modules/.bin/ray` by `npm install` — it is **not** a
globally-installed tool. The npm scripts find it automatically; outside an npm
script use `npx ray <…>` from inside `raycast-extension/`.

`ray develop` registers the extension with the local Raycast app and
hot-reloads on save. The commands appear in Raycast immediately under their
configured titles. Logs (including `console.log` / `console.error` from the
extension) stream to the terminal that ran `npm run dev`.

Stop development mode with `Ctrl-C`. The extension stays installed but stops
hot-reloading; relaunching `npm run dev` resumes.

**Important**: the extension shells out to the *installed* `bookmark-index`
binary, **not** the source tree. After editing CLI code that the extension
depends on, run `make install` so the extension picks up the new behavior.
A typical inner loop touching both sides:

```bash
# terminal A
npm --prefix raycast-extension run dev
# terminal B (after editing src/…)
make install
```

### Lint / format

```bash
cd raycast-extension
npm run lint                             # ESLint + Prettier check
npm run fix-lint                         # auto-fix
```

Run before committing or shipping. Pre-existing lint issues unrelated to your
change will surface — fix them in a separate commit if cleanup is appropriate.

### Build for production

```bash
cd raycast-extension
npm run build                            # wraps `ray build`
```

Produces a production build under `raycast-extension/.build/`. There is also a
top-level convenience target:

```bash
make raycast                             # cd raycast-extension && npm install && npm run build
```

### Publishing / "deploying to prod"

This extension is **not published to the Raycast Store**. It runs locally as a
private extension. "Deploying" means making sure the local Raycast install is
running the latest code:

1. `cd raycast-extension && npm run build` (or `make raycast`).
2. In Raycast: open the extension list, confirm the commands load and the
   preferences (binary path, OpenRouter key, etc.) are populated.
3. Smoke-test each command:
   - **Match URL** — open a Safari tab to a known-categorized URL, invoke the
     command, verify the top match and that any human-authored project shows
     as a green tag.
   - **Show Tab Group** — open a Safari tab group that exists in the DB,
     invoke the command, edit project + notes, save, re-invoke to confirm
     persistence. Then run `safari-sync && bookmark-index update` and re-open
     to verify the user fields survived.

If you ever do want to publish to the Raycast Store, the path is
`npx ray publish` from inside `raycast-extension/` — this requires a Raycast account and a PR
into [raycast/extensions](https://github.com/raycast/extensions). Don't do
this without intent; the `binaryPath` preference assumes a local CLI install.

## Coordinated changes (CLI + extension)

When a change spans both:

1. Modify `src/` and add tests in `test/`.
2. `bun test` to verify.
3. `make install` to publish the binary the extension calls.
4. Modify `raycast-extension/src/` and `raycast-extension/package.json`
   (commands, preferences, args).
5. `npm --prefix raycast-extension run dev` and exercise the changed flow.
6. `npm --prefix raycast-extension run lint` before committing.

The CLI is the source of truth for DB shape and validation — keep validation
(e.g. `MAX_PROJECT_LENGTH`) in `src/user-fields.ts` and mirror it in the
extension as a UX guard, not as the only check.

## Type checking

The project does not currently enforce a typecheck step in CI; `bunx tsc
--noEmit` reports pre-existing TS config noise (`.ts` import extensions,
`smol-toml` typings). Use `bun test` and `npm run lint` as the primary
correctness signals, and rely on Bun's runtime to surface type-shaped issues
that matter.

## Releasing CLI changes to your own machine

The "release" model for the CLI is simply `make install`. There is no remote
package registry. To roll back, `git checkout` the prior commit and re-run
`make install`. The database has no destructive migrations — every schema
change is an idempotent `ADD COLUMN`, so older binaries continue to read newer
DBs (they just ignore the extra columns).
