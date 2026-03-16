# Constraint Format Specification

How to write the CLAUDE.md and architecture.md files that steer future agents.

## CLAUDE.md Format

CLAUDE.md is always loaded into the agent's context. Keep it under 25 lines. It contains only the hardest constraints and a pointer to the detailed reference.

### Template

```markdown
# {{ project_name }}

## Architecture

- [Constraint 1 in imperative form]
- [Constraint 2 in imperative form]
- [Constraint 3 in imperative form]
- ...max 10 constraints
- Read `.claude/architecture.md` before creating new files or making structural changes.

## File Layout

[Brief directory map showing where new code goes]
```

### What qualifies as a CLAUDE.md constraint

A constraint belongs in CLAUDE.md if ALL of these are true:
- It's universal — applies to every file, every task
- Violating it would be architecturally wrong, not just inconsistent
- An agent might plausibly do the wrong thing without this constraint
- It can be stated in one imperative sentence

Examples of good CLAUDE.md constraints:
- "Runtime: Bun. Never use Node.js-only APIs."
- "No CLI framework. Parse flags manually with Set<string> for booleans."
- "Every command supports `--json` for structured output."
- "SQLite with WAL mode via `bun:sqlite`. No ORMs."

Examples of things that should NOT be in CLAUDE.md:
- "Functions should be camelCase" (convention, not architecture)
- "Use the strategy pattern for LLM backends" (pattern, too specific for always-on context)
- "Config files use TOML format parsed with smol-toml" (pattern, only relevant when touching config)

## architecture.md Format

The detailed reference file. Starts with the Design Philosophy section, then organizes decisions by concern.

### Template

```markdown
# Architecture Decisions

## Design Philosophy

[2-3 paragraphs explaining what kind of project this is, who/what it's built for,
how the pieces fit together, and why the major decisions were made. This section
gives future agents the mental model for the entire project. An agent that
understands the philosophy will make better judgment calls on every decision,
even ones not explicitly listed below.]

[Include philosophy-driven requirements — concrete implications that flow from
the philosophy and constrain every new piece of code.]

## [Concern Area 1]

- **[Decision Name]** — [Directive in imperative form]. [Brief "why" — 1 sentence]. See `[file:lines]`.

- **[Decision Name]** — [Directive]. [Why]. See `[file:lines]`.

## [Concern Area 2]

...

## Conventions

- **[Convention Name]** — [Description]. [Why or source].
```

### Concern areas

Organize decisions under headings that match the codebase. Common headings:

- **Runtime & Build** — language, runtime, compilation, binary distribution
- **Config & Paths** — config format, path resolution, environment handling
- **Data Layer** — database, schema, migrations, queries
- **CLI Patterns** — argument parsing, output modes, help text
- **API Integration** — HTTP clients, auth, retry, validation
- **Error Handling** — error reporting, exit codes, recovery
- **Module Organization** — file structure, import patterns, separation of concerns
- **Process Management** — subprocesses, concurrency, worker patterns
- **Logging & Observability** — logging, metrics, tracing
- **Testing** — framework, patterns, fixtures
- **Conventions** — naming, formatting, commit messages, documentation

Not every codebase needs every heading. Use only the ones that have decisions to document.

### Writing decisions

Each decision follows this pattern:

```
- **Name** — Directive. Why. File pointer.
```

**Name**: 2-5 words, bold. Should be immediately recognizable.

**Directive**: Imperative sentence. "Use X for Y." or "Never do Z." Be specific enough that an agent can follow it without reading the referenced file.

**Why**: One sentence explaining the rationale. This helps agents make judgment calls when a user request partially conflicts with the constraint. Focus on the concrete benefit, not philosophy.

**File pointer**: `See src/config.ts:12-45` pointing to the skeleton file in the generated project that demonstrates this pattern. Use line ranges when helpful.

### Design Philosophy example

```markdown
## Design Philosophy

This project builds composable, agent-consumable CLI tools. Each tool is an
independent binary that does one thing, produces structured JSON output, and
can be consumed by other tools or AI agents via subprocess spawning. Tools
compose by piping JSON — higher-level orchestrators spawn lower-level tools
in parallel, merge their output, and handle partial failure gracefully.

Help text is designed as interface documentation for agents: it lists purpose,
prerequisites ("run X first"), output format, and failure modes — not just
flags. Every command supports `--json` because structured output is the
composition interface. Without it, a tool can't participate in the ecosystem.

New tools must follow these philosophy-driven requirements:
- Help text must include: purpose, prerequisites, output format, all flags
- Support `--json` for structured output (this is how tools compose)
- Handle partial failure gracefully (continue with available data)
- Produce output compatible with the canonical JSON schema
- Work as both a standalone binary and a `bun run` script
```

### Examples across ecosystems

**TypeScript CLI:**
```markdown
## CLI Patterns

- **Manual flag parsing** — Parse CLI flags with `Set<string>` for booleans and manual iteration for key-value pairs, no CLI framework. Keeps binary size small and avoids dependency churn for simple tools. See `src/main.ts:8-40`.

- **JSON output mode** — Every command supports `--json` to emit structured output on stdout. Enables subprocess aggregation where commands compose by piping JSON to each other. See `src/main.ts:55-62`.
```

**Python data pipeline:**
```markdown
## Data Layer

- **DuckDB for analytics** — Use DuckDB for all analytical queries, not pandas or SQLite. Handles large datasets without loading into memory and supports SQL directly on Parquet files. See `src/query.py:15-30`.

- **Parquet for storage** — Store intermediate results as Parquet files in `data/`, not CSV. Preserves types, compresses well, and integrates natively with DuckDB. See `src/pipeline.py:88-95`.
```

**Go service:**
```markdown
## Error Handling

- **Wrap errors with context** — Use `fmt.Errorf("operation: %w", err)` to wrap all errors with the operation name. Produces readable error chains without a third-party library. See `internal/service/handler.go:45-52`.

- **Structured logging** — Use `slog` for all logging, never `fmt.Println` or `log.Printf`. Structured logs enable filtering and aggregation in production. See `internal/logging/logger.go:8-20`.
```

### The conventions section

Conventions are lighter than decisions — they're about style and process rather than architecture. Keep them brief:

```markdown
## Conventions

- **File naming** — kebab-case for all source files (`safari-sync.ts`, `raindrop-sync.ts`).
- **Function naming** — camelCase, verb prefix for actions (`resolveConfigPath`, `fetchAndConvert`).
- **Commit messages** — Imperative mood, descriptive. No conventional commits prefix.
- **No inline comments** — Code should be self-explanatory. Use comments only for non-obvious "why" explanations.
```

## Tone and Style

- Use imperative mood throughout ("Use X", "Never do Y", not "We use X" or "You should use Y")
- Be specific enough to act on, general enough to apply across tasks
- Include the "why" to enable judgment — if an agent knows WHY manual flag parsing matters (binary size), it can make the right call when a user asks for something complex enough to warrant a framework
- File pointers should reference files in the generated project, not the source codebase
