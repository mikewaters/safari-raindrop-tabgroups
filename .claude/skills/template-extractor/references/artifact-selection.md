# Artifact Selection Guide

Use this guide to decide which files the Copier template should include, based on what the codebase analysis reveals.

## Always Include

These artifacts go in every template regardless of ecosystem:

| Artifact | Purpose |
|----------|---------|
| `CLAUDE.md.jinja` | Top 5-10 hard constraints + pointer to architecture.md |
| `.claude/architecture.md.jinja` | Full architecture decisions by concern |
| `.gitignore` | Standard ignores for the ecosystem |
| `copier.yml` | Project questions and feature toggles |

## Ecosystem-Specific Config Files

Include the config files appropriate to the detected ecosystem:

### TypeScript / JavaScript
| If detected | Include |
|-------------|---------|
| package.json | `package.json.jinja` with scripts, bin, deps, type:module |
| tsconfig.json | `tsconfig.json` (usually not templated — compiler options rarely vary) |
| Bun runtime | No extra config needed (Bun uses package.json + tsconfig.json) |
| Node runtime | Consider `.nvmrc` or `.node-version` |

### Python
| If detected | Include |
|-------------|---------|
| pyproject.toml | `pyproject.toml.jinja` with project metadata, deps, tool configs |
| uv / pip | Lock file generation instructions in CLAUDE.md |
| src layout | `src/{{ project_slug }}/__init__.py.jinja` |

### Go
| If detected | Include |
|-------------|---------|
| go.mod | `go.mod.jinja` with module path |
| cmd/ pattern | `cmd/{{ project_slug }}/main.go.jinja` |
| internal/ | Directory structure only |

### Rust
| If detected | Include |
|-------------|---------|
| Cargo.toml | `Cargo.toml.jinja` with package metadata |
| src/main.rs or src/lib.rs | Entry point skeleton |

## Build / Task Runner

Include whichever the codebase uses:

| Detected | Include |
|----------|---------|
| Justfile | `Justfile.jinja` with build, install, clean targets |
| Makefile | `Makefile.jinja` with equivalent targets |
| Neither | Skip — let the ecosystem's native tools handle it |

## Skeleton Source Files

Include skeleton files when:
- The codebase has a **clear, consistent pattern** for a common operation (arg parsing, config loading, etc.)
- The pattern is **non-obvious** — an agent wouldn't naturally write it this way without guidance
- The file can **stand alone** under ~80 lines with minimal business logic

Skip skeleton files when:
- The pattern is the ecosystem default (e.g., standard Go error handling — agents already know this)
- The file would be mostly business logic with little structural code
- The pattern is already fully described in architecture.md (prose is sufficient)

### What makes a good skeleton

A skeleton file should demonstrate 2-4 patterns simultaneously. For a CLI tool, one skeleton entry point might show: arg parsing + config loading + JSON output mode + verbose logging. That's more useful than four separate single-pattern files.

### Templatization rules

Replace in skeleton files:
- Project name / slug references → `{{ project_slug }}`
- Config file paths → `{{ project_slug }}.config.toml` or similar
- Database file names → `{{ project_slug }}.db`
- Binary / command names → `{{ project_slug }}`

Do NOT templatize:
- The structural patterns themselves (flag parsing, error handling, logging)
- Import paths for ecosystem packages
- Type definitions and interfaces
- Comments explaining the pattern

## Optional Artifacts

Include only when strong evidence exists:

| Artifact | When to include |
|----------|----------------|
| `.claude/skills/` | Codebase has complex multi-step workflows documented in existing skills |
| Linting config | Codebase has non-default linting rules that represent deliberate decisions |
| CI/CD config | Only if the user specifically asks — CI pipelines are too environment-specific |
| Docker config | Only if the codebase uses containerized deployment |
| Test fixtures | Only if the testing pattern is non-obvious |

## Decision Checklist

For each potential artifact, ask:
1. Does this file steer agent behavior? → Include
2. Does this file enforce a constraint mechanically? → Include
3. Is this file purely documentation with no behavioral impact? → Probably skip (put the info in architecture.md instead)
4. Would an agent naturally create this file correctly without guidance? → Skip
5. Is this file too project-specific to generalize? → Skip
