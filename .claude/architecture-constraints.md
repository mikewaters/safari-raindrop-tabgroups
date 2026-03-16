# Architecture Constraints

> Extracted from safari-tabgroups on 2026-03-08

## CLAUDE.md

```markdown
# safari-tabgroups

## Architecture

- Runtime: Bun. Use `bun:sqlite` for databases, `Bun.spawn` for subprocesses. Never use node:child_process.
- No CLI framework. Parse flags manually from `process.argv.slice(2)`.
- Every command must support `--json` for structured output on stdout.
- All diagnostic output to stderr (`console.error`), data output to stdout (`console.log`).
- Secrets in config as `$ENV_VAR_NAME`, resolved at runtime via `process.env`. Never store secrets directly.
- Each entry point compiles to a standalone binary via `bun build --compile`. Add new entry points to both `Makefile` and `package.json`.
- Config resolution: compiled binaries read `$XDG_CONFIG_HOME/<app>/config.toml`, dev mode reads project-root config. See `src/config.ts`.
- SQLite databases use WAL journaling and foreign keys enabled via PRAGMA.
- `--json` output must follow a documented TypeScript interface. Sibling tools depend on these contracts.
- LLM calls traced via Langfuse (non-blocking, opt-in via env vars). Never let observability fail the operation.
- Read `.claude/architecture.md` before creating new files or making structural changes.

## File Layout

- `src/<command>.ts` — Independent entry points, one per binary
- `src/config.ts` — Shared config path resolution
- `src/match/` — Strategy-pattern modules for match algorithms
- `Makefile` — Build, install, uninstall, clean targets
- `fetch.config.toml` — Dev-mode config (TOML format, parsed with smol-toml)
```

## Architecture Decisions

### Design Philosophy

This project builds composable, agent-consumable CLI tools as a suite of microcommands. Each tool is an independently compiled binary that does one thing, produces structured JSON on stdout, and logs diagnostics to stderr. Tools compose by spawning each other as subprocesses — orchestrators fan out to leaf tools in parallel using `Promise.all`, merge their JSON output, and degrade gracefully when individual sources fail.

Help text serves as interface documentation for both humans and AI agents: it lists purpose, prerequisites ("run X first"), output format, and all flags. Every command supports `--json` because structured output is the composition interface — without it, a tool cannot participate in the ecosystem. Configuration follows XDG conventions with a clean dev/production bifurcation: dev mode reads config from the project root, compiled binaries resolve from `~/.config/<app>/`. Secrets are never stored directly — config references environment variables that are resolved at runtime.

New tools must follow these philosophy-driven requirements:
- Support `--json` for structured output (the composition interface)
- Include help text with: purpose, prerequisites, output format, all flags
- Handle partial failure gracefully (continue with available data, exit 1 only if ALL sources fail)
- Produce output compatible with the profiles/tabGroups/tabs JSON schema
- Work as both a standalone binary and a `bun run` script

### Runtime & Build

- **Bun runtime** — Use Bun as the sole runtime. Use `bun:sqlite` for database access, `Bun.spawn` for subprocesses, and bun-compatible Node APIs (`node:fs`, `node:path`, `node:os`) for filesystem operations. Never use `node:child_process`. See `src/raindrop.ts:1`.

- **Standalone binary compilation** — Compile each entry point to a self-contained binary via `bun build --compile --outfile <name>`. Every new command needs a build line in `Makefile` and a run script in `package.json`. See `Makefile:15-24`.

- **TypeScript strict mode** — Target ESNext with module resolution set to `bundler`. Strict mode is always enabled. See `tsconfig.json`.

- **Testing with bun test** — Use `bun test` as the test framework. Test files use the `.test.ts` suffix. See `package.json` scripts.

### Config & Paths

- **TOML config via smol-toml** — Parse config files with `smol-toml`'s `parse()` function, cast to a typed interface. Each tool reads its own section from the config. See `src/fetch.ts:100-111`.

- **Dev vs compiled config resolution** — Detect compiled mode via `import.meta.dir.startsWith('/$bunfs')`. Compiled binaries resolve config from `$XDG_CONFIG_HOME/<app>/config.toml`; dev mode uses `<project-root>/fetch.config.toml`. See `src/config.ts:9-17`.

- **Environment variable API key resolution** — Store API keys in config as `$ENV_VAR_NAME`. At runtime, if the value starts with `$`, resolve via `process.env`. Exit with error if the resolved value is empty. See `src/fetch.ts:114-121`.

- **XDG cache directory** — Store cache files under `$XDG_CACHE_HOME/<app>/` (defaulting to `~/.cache/<app>/`). Create the directory with `mkdirSync({recursive: true})`. See `src/raindrop.ts:42-46`.

### CLI Patterns

- **Manual flag parsing** — Parse CLI flags manually using `process.argv.slice(2)`. No CLI framework. Two variants exist: `new Set(argv)` for boolean-only tools (simpler, see `src/raindrop.ts:16`), and `for` loop with `argv[++i]` for tools needing key-value flags like `--db <path>` (see `src/fetch.ts:28-53`). The loop-based approach is a superset — prefer it for new tools unless the tool truly only needs boolean flags.

- **Help-first exit** — Check for `--help`/`-h` before any other logic. Print a structured help string (name, purpose, usage, options, prerequisites) and exit 0. See `src/raindrop.ts:18-32`.

- **Verbose log function** — Define a local `function log(...msg: unknown[])` that writes to stderr only when `verbose` is true. Prefix with `[debug]` or a tool-specific tag. See `src/raindrop.ts:37-39`.

- **JSON/text dual output** — Support `--json` flag that switches output from human-readable text to `JSON.stringify(output, null, 2)`. Diagnostics always go to stderr regardless of output mode. See `src/raindrop.ts:125-135`.

- **JSON output contracts** — Each tool's `--json` output should follow a documented schema. Define TypeScript interfaces for the output shape and document the contract in `--help` text. Sibling tools that consume each other's output depend on these contracts being stable. See `src/list.ts:53-55` for the shared `Profile/TabGroup/Tab` interfaces.

### Data Layer

- **SQLite with WAL and foreign keys** — Open databases with `new Database(path)` from `bun:sqlite`. Immediately enable WAL journaling and foreign keys via PRAGMA. Create tables with `CREATE TABLE IF NOT EXISTS`. No ORMs. See `src/index.ts:143-147`.

### API Integration

- **OpenRouter API pattern** — HTTP POST to `https://openrouter.ai/api/v1/chat/completions` with Bearer auth. Always include `X-Title` and `HTTP-Referer` headers for app attribution. Body contains `model` and `messages` array. See `src/fetch.ts:133-161`.

### Process Management

- **Subprocess composition via Bun.spawn** — Spawn sibling tools via `Bun.spawn(cmd, {stdout:'pipe', stderr:'pipe'})`. Capture stdout with `new Response(proc.stdout).text()`, check `proc.exitCode` after `await proc.exited`. Always pass `--json` when spawning sibling tools. See `src/list.ts:69-82`.

- **Compiled vs dev command resolution** — Detect compiled mode via `import.meta.dir.startsWith('/$bunfs')`. Compiled mode spawns the binary name directly; dev mode spawns `['bun', 'run', join(import.meta.dir, 'sibling.ts')]`. See `src/list.ts:62-67`.

- **Graceful degradation on partial failure** — Orchestrators track failed sources and only exit 1 if ALL sources fail. Partial data is still emitted. See `src/list.ts:108-111`.

### Error Handling

- **Stderr for diagnostics, stdout for data** — Use `console.error` for all diagnostics, status messages, and errors. Reserve `console.log` for primary output data. Exit 0 on success, exit 1 on error. See `src/raindrop.ts:116-117`.

### Observability

- **Langfuse for LLM tracing** — Use [Langfuse](https://langfuse.com/) to trace LLM calls. Initialize a lazy singleton via `getLangfuse()` that returns `null` when `LANGFUSE_SECRET_KEY`/`LANGFUSE_PUBLIC_KEY` env vars are absent. This makes observability opt-in: it works when configured, is invisible when not. See `src/describe.ts:10-27`.

- **Non-blocking observability** — Langfuse calls must never fail the primary operation. Use optional chaining (`langfuse?.trace(...)`, `generation?.end(...)`) and swallow flush errors (`langfuse?.flushAsync().catch(() => {})`). Observability is a cross-cutting concern that degrades silently. See `src/describe.ts:277-310`.

- **Trace per operation** — Create one Langfuse trace per LLM call with structured input/output metadata: tool name, model, input parameters, and output (or error). End each generation span with usage stats when available. See `src/match/llm-fetch.ts:447-517`.

### Module Organization

- **Strategy pattern for pluggable algorithms** — Algorithms implement a `MatchStrategy` interface with a `match(params)` method. Strategies self-register into a module-level `Map` via `strategyRegistry.set()` at import time. See `src/match/types.ts`.

### Conventions

- **File naming** — kebab-case for all source files (`safari-sync.ts`, `raindrop-sync.ts`).
- **Function naming** — camelCase with verb prefix for actions (`resolveConfigPath`, `fetchAndConvert`).
- **Type naming** — PascalCase interfaces (`TabGroup`, `Profile`, `MatchResult`).
- **Binary naming** — kebab-case matching the tool's purpose (`safari-tabgroups`, `bookmark-index`).
- **Commit messages** — Imperative or past-tense sentence, no conventional-commit prefix.

## Metadata

- **Source codebase**: /Users/mike/Develop/workos/safari-tabgroups
- **Decisions extracted**: 33
- **Hard constraints**: 11
- **Patterns**: 15
- **Conventions**: 7
- **Concern areas**: Runtime & Build, Config & Paths, CLI Patterns, Data Layer, API Integration, Process Management, Error Handling, Observability, Module Organization, Conventions

### Decision Inventory

| Decision | Classification | In CLAUDE.md | Evidence |
|----------|---------------|:---:|----------|
| Bun as sole runtime | hard_constraint | ✓ | All files use bun:sqlite, Bun.spawn; tsconfig types: [bun-types] |
| No CLI framework — manual flag parsing | hard_constraint | ✓ | 9/9 executable files parse argv manually |
| Every command supports --json | hard_constraint | ✓ | 5/8 entry points have --json, philosophy requires it |
| Stderr for diagnostics, stdout for data | hard_constraint | ✓ | All 9 executable files follow this pattern |
| Secrets via env var indirection | hard_constraint | ✓ | 4 files resolve $ENV_VAR_NAME from config at runtime |
| Each entry point compiles to standalone binary | hard_constraint | ✓ | Makefile has 8 bun build --compile targets |
| Config resolution: compiled vs dev mode | hard_constraint | ✓ | src/config.ts:9-17, used by 4 files |
| SQLite with WAL and foreign keys via PRAGMA | hard_constraint | ✓ | src/index.ts:143-147, 3 files |
| New entry points in both Makefile and package.json | hard_constraint | ✓ | Dual-mode execution requires both; 8 entries in each |
| Testing with bun test | hard_constraint | | package.json scripts.test, bun test configured |
| TypeScript strict mode enabled | hard_constraint | | tsconfig strict:true |
| TOML config parsed with smol-toml | pattern | | 4 files import smol-toml parse() |
| Help-first exit pattern | pattern | | 8/8 entry points check --help before any logic |
| Verbose log function per file | pattern | | 8/8 files define local log() gated on verbose flag |
| XDG cache directory for local data | pattern | | 5 files use $XDG_CACHE_HOME/safari-tabgroups/ |
| Subprocess composition via Bun.spawn with --json | pattern | | 3 files spawn sibling tools, capture JSON stdout |
| Compiled vs dev command resolution via import.meta.dir | pattern | | 3 files check startsWith('/$bunfs') |
| Graceful degradation on partial source failure | pattern | | list.ts:108-111 exits 1 only when all sources fail |
| OpenRouter API with X-Title and HTTP-Referer headers | pattern | | 3 files call OpenRouter with attribution headers |
| Strategy pattern for match algorithms | pattern | | src/match/types.ts defines MatchStrategy interface |
| Bun.spawn with pipe capture pattern | pattern | | 4 files use new Response(proc.stdout).text() |
| ESModule system (type: module, ESNext target) | pattern | | package.json type:module, tsconfig module:ESNext |
| JSON output contracts with typed interfaces | pattern | | list.ts:53-55 shared Profile/TabGroup/Tab interfaces |
| Langfuse for LLM tracing (non-blocking) | pattern | | describe.ts:10-27, match/llm-fetch.ts:6-23 |
| Non-blocking observability via optional chaining | pattern | | flushAsync().catch(() => {}) in 2 files |
| Trace per LLM operation with structured metadata | pattern | | describe.ts:277-310, match/llm-fetch.ts:447-517 |
| kebab-case file naming | convention | | All source files use kebab-case |
| camelCase function naming | convention | | resolveConfigPath, fetchAndConvert, etc. |
| PascalCase type/interface naming | convention | | TabGroup, Profile, MatchResult, MatchStrategy |
| kebab-case binary naming | convention | | safari-tabgroups, bookmark-index, fetch-tabgroup |
| Imperative commit messages, no conventional prefix | convention | | Recent commits confirm pattern |
| Single-branch workflow on master | convention | | git status shows master, no branching strategy |
| No linting or formatting tools | convention | | No eslint, prettier, or biome in project |

### Resolved Decisions

These were initially uncertain but have been resolved by the user:

1. **bun test is the test framework** — Enforced. Zero test files exist currently but the framework is intentional.
2. **No linting is an omission** — Not a deliberate decision. Linting/formatting tools may be added later.
3. **JSON schemas are data contracts** — The `--json` output shape should be documented and stable. Define TypeScript interfaces for output schemas and document them in `--help`.
4. **Observability is a constraint category** — Langfuse is the observability tool. The lazy-singleton + non-blocking pattern is a hard pattern. The `langfuse` dependency should be in generated templates.
5. **Both flag parsing variants are valid** — `Set`-based for boolean-only tools, loop-based for key-value flags. Loop-based is preferred for new tools as it's a superset.

### Skeleton File Candidates

| Source File | Recommended Template Name | Lines | Patterns Demonstrated |
|-------------|--------------------------|------:|----------------------|
| `src/raindrop.ts` | `src/main.ts` | 136 | Manual flag parsing, help-first exit, verbose log, JSON/text dual output, XDG cache, stderr/stdout separation, shebang |
| `src/config.ts` | `src/config.ts` | 17 | XDG config resolution, compiled vs dev detection |
| `src/fetch.ts` | `src/fetch.ts` | 162 | Key-value flag parsing, TOML config loading, env var API key resolution, OpenRouter API, help-first exit |
| `src/list.ts` | `src/orchestrator.ts` | 125 | Subprocess composition, compiled vs dev command resolution, graceful degradation, Bun.spawn pipe capture, parallel fan-out |
| `Makefile` | `Makefile` | 62 | Binary compilation, XDG config install, prefix-based install |
