# Known Design Philosophies

Use this reference to help identify design approaches in the codebase being analyzed. These are patterns you might recognize — don't force-fit them. A codebase may follow one, several, a hybrid, or something entirely novel.

## Agent-Optimized CLI Design

The tools are built primarily for programmatic consumption by other tools or AI agents, not for interactive human use.

**Indicators:**
- Help text reads like API documentation: lists purpose, input requirements, output format, prerequisites, and failure modes
- Every command supports structured output (usually `--json`)
- No interactive prompts — all input comes from flags, positional args, or stdin
- Errors go to stderr with specific exit codes; stdout is reserved for data
- Help text explicitly states dependencies ("Run X first to populate the cache")

**Implications for templates:**
- Every new command must include comprehensive `--help` that tells an agent everything it needs: what the tool does, what it needs as input, what it produces, what to run first
- Structured output is not optional — it's the primary interface
- Argument parsing should be strict and predictable, no ambiguous shortcuts
- Error messages should be machine-parseable (consistent format, on stderr)

## Microcommand Composition

Individual tools are independently usable but designed to compose into higher-level workflows by calling each other.

**Indicators:**
- Multiple independent entry points compiled to separate binaries
- Orchestrator tools that spawn other tools as subprocesses
- JSON contracts between tools (canonical schemas shared across the ecosystem)
- Graceful degradation — orchestrators handle partial failure from dependencies
- Parallel execution of independent dependencies
- Dev/production mode detection for finding sibling commands

**Implications for templates:**
- Each new tool must produce output compatible with the canonical schema
- Orchestrators should spawn dependencies in parallel when possible
- Partial failure is acceptable — continue with available data, fail only when ALL sources fail
- The `--json` flag is the composition interface — without it, a tool can't participate
- Tools must detect whether they're running in dev or compiled mode to find siblings

**Relationship to Unix Philosophy:**
Similar to Unix pipes, but with structured data (JSON) instead of text streams. The key difference: Unix pipes are linear (A | B | C), while microcommand composition often fans out (orchestrator spawns A, B, C in parallel, merges results).

## XDG Configuration Strategy

Configuration, data, and cache are organized according to the XDG Base Directory specification, with clear separation between development and production paths.

**Indicators:**
- Config in `$XDG_CONFIG_HOME/<app>/` (default `~/.config/<app>/`)
- Persistent data in `$XDG_DATA_HOME/<app>/` (default `~/.local/share/<app>/`)
- Cache in `$XDG_CACHE_HOME/<app>/` (default `~/.cache/<app>/`)
- Dev mode uses project-root config; production uses XDG paths
- Runtime detection of dev vs. production (e.g., checking for bundled filesystem markers)
- Environment variable expansion in config values (`$VAR` → `process.env.VAR`)

**Implications for templates:**
- Never hardcode `~/.app-name/` — use XDG paths with fallbacks
- Config should be seeded on install (copied once, never overwritten)
- The dev/production detection mechanism should be documented and consistent
- Secrets should reference environment variables in config, not be stored directly

## Standalone Binary Distribution

Tools are compiled to self-contained binaries with no runtime dependencies.

**Indicators:**
- Build step produces standalone executables (e.g., `bun build --compile`, `go build`, `cargo build --release`)
- Install step copies binaries to a prefix directory (e.g., `~/.local/bin/`)
- No runtime installation required for end users
- Build system handles both compilation and installation
- Config seeding during install (copy template config if not exists)

**Implications for templates:**
- Build system must compile each entry point independently
- Install target should handle binary copying AND config seeding
- Uninstall should remove binaries but preserve user config
- The build/install flow should be a single command (e.g., `make install`)

## Other Philosophies (not exhaustive)

### Library-First
The project is primarily a library consumed by other projects, with CLI as a thin wrapper.
- Indicators: main exports in `index.ts`/`lib.rs`/`__init__.py`, CLI is in a separate `bin/` or `cmd/` directory, most code is in importable modules.

### Service-Oriented
Long-running processes that communicate via network protocols.
- Indicators: HTTP/gRPC server setup, health check endpoints, graceful shutdown handlers, middleware chains.

### Pipeline / ETL
Data flows through a series of transformations.
- Indicators: Stage-based processing, intermediate state files, checkpoint/resume logic, progress reporting.

### Monolith with Subcommands
Single binary with multiple subcommands (like `git`).
- Indicators: Command router/dispatcher, shared argument parsing, single entry point with `switch`/`match` on first positional arg.

---

When analyzing a codebase, you may find it matches one philosophy cleanly, combines several, or follows something not listed here. The goal is to name and articulate the philosophy, not to force-fit into a category.
