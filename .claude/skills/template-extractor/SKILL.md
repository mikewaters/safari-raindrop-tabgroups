---
name: template-extractor
description: >-
  Extract architecture decisions from a codebase and produce a Copier template
  that steers future agents to follow the same patterns. Use this skill whenever
  the user wants to create a project template, extract architecture constraints,
  capture codebase patterns for reuse, generate a Copier template, or create
  agent instructions from an existing project. Also use when someone says
  "templatize this", "extract patterns", "create a starter kit", or
  "make a template from this codebase".
---

# Template Extractor

You analyze a mature codebase, extract the architecture decisions that make it good, and produce a **Copier template** — a git repo that scaffolds new projects with those same decisions baked in via CLAUDE.md, architecture reference files, skeleton code, and ecosystem-appropriate config.

The template steers future agents through progressive disclosure:
- **CLAUDE.md** (always in context): top 5-10 hardest constraints + pointer to architecture.md
- **.claude/architecture.md** (loaded on demand): full decisions organized by concern, each with a brief "why" and file pointer to skeleton code
- **Skeleton source files**: demonstrate key patterns so agents can pattern-match from real code
- **Config files**: ecosystem-appropriate (package.json, pyproject.toml, go.mod, etc.)

This skill is **domain-agnostic** — it works in TypeScript, Python, Go, Rust, or any other ecosystem. The artifact set it produces is itself a reasoned decision based on what the codebase analysis reveals.

## Output location

Create a temp workspace for the template output:
```bash
WORKSPACE=$(mktemp -d)
```

Write all generated files to `$WORKSPACE/`. The final template directory lives at `$WORKSPACE/` and can be moved or `git init`'d by the user after review. Print the workspace path so the user can find it.

## Workflow

### Phase 1: Research the codebase

Launch 4 subagents in parallel. Read the agent prompts in `agents/` (relative to this skill) before spawning them.

**Subagent A — Structure Analyzer** (read `agents/structure-analyzer.md`):
Maps the codebase: language, runtime, package manager, build system, dependency manifest, command/module pattern, testing and linting tools. Outputs structured JSON.

**Subagent B — Pattern Extractor** (read `agents/pattern-extractor.md`):
Reads source files and identifies recurring code patterns: arg parsing, CLI interface design, tool composition, config loading, data access, error handling, logging, API integration, module organization. For each pattern: canonical file+line, frequency, variations. Outputs a list of patterns with evidence.

**Subagent C — Convention Detector** (read `agents/convention-detector.md`):
Examines CLAUDE.md, AGENTS.md, skills, README, CONTRIBUTING, docs, git log, linting config. Identifies naming conventions, commit conventions, documented decisions (ADRs). Outputs a list of conventions with sources.

**Subagent D — Design Philosophy Analyzer** (read `agents/philosophy-analyzer.md`):
Reads the codebase holistically to identify the design intent: who are the tools for (agents, humans, both)? How do the pieces compose? What's the deployment model? What's the configuration philosophy? Outputs a philosophy summary, composition model, and philosophy-driven requirements. Pass it the path to `references/design-philosophies.md` for known design approaches to look for.

### Phase 2: Synthesize the architecture constraints

Spawn a **Synthesizer** subagent (read `agents/synthesizer.md`). Pass it:
- The four research outputs from Phase 1 (structure, patterns, conventions, philosophy)
- The path to `references/constraint-format.md`

The synthesizer starts by writing the Design Philosophy section (from the philosophy analyzer's output), then classifies every finding (hard constraint vs. pattern vs. convention), writes the CLAUDE.md and architecture.md, selects skeleton file candidates, and returns everything as structured JSON. This is the most reasoning-intensive step — the synthesizer agent prompt contains the full classification logic, decision-writing guidelines, and output format.

The synthesizer's output includes `uncertain_decisions` — decisions it wasn't sure about. Review these and resolve any that need user input before proceeding.

### Phase 3: Assemble the template

With the synthesizer's output in hand:

1. **Select the artifact set** by consulting `references/artifact-selection.md`. The ecosystem (from the structure analyzer) determines which config files, build tools, and skeleton patterns to include.

2. **Templatize skeleton files** — Take the synthesizer's skeleton recommendations and create Jinja2-templated versions. Replace project-specific names with `{{ project_slug }}` etc. Light touch — files should read as real code, not Jinja2 soup. Only templatize: project name/slug, config file paths, binary names, database file names.

3. **Generate copier.yml** — Project identity questions (name, slug, description) + feature toggles for optional patterns. Hard constraints are baked in, not questioned. See `references/copier-guide.md`.

4. **Assemble the template directory** — Create the Copier template structure with `copier.yml` at the root and a `{{ project_slug }}/` subdirectory containing all generated files.

### Phase 4: Validate

Before presenting to the user, verify:
- CLAUDE.md is under 25 lines
- Every file pointer in CLAUDE.md and architecture.md resolves to an actual skeleton file in the template
- copier.yml has sensible defaults for all questions
- Generated files are syntactically valid for their language/format

If `copier` is available, run `copier copy` with test answers into a temp directory and check the output.

### Phase 5: Present to the user

Show the user:
1. The generated CLAUDE.md (full text)
2. The generated architecture.md (full text)
3. The copier.yml questions and defaults
4. A list of skeleton files with what pattern each demonstrates
5. Any decisions you're uncertain about

Ask for feedback before finalizing. Iterate if needed.

## Important notes

- The template is a Copier git repo. The user will `copier copy` from it to scaffold new projects.
- Hard constraints should use imperative language ("Use X. Never use Y.") but always include a brief "why" in architecture.md so agents can reason about edge cases.
- CLAUDE.md file pointers reference skeleton files *within the generated project*, not the source codebase. Use relative paths like `src/config.ts`.
- When in doubt about whether something is a hard constraint vs. pattern, err toward pattern. Overly rigid CLAUDE.md files frustrate users who need flexibility.
- Skeleton files should work as real code after `copier copy`, not just be documentation. If a skeleton file can't function standalone, it's too abstract.

## Common pitfalls

These issues came up in testing. Avoid them:

- **Skeleton/constraint consistency**: If the extracted constraints say "use runtime X's native APIs", the skeleton files must follow that rule too. Don't import `node:fs` in a skeleton while the CLAUDE.md says "never use Node.js APIs." Read the generated CLAUDE.md constraints, then audit every skeleton file against them before finalizing.

- **Detect, don't assume, the build tool**: The source codebase may use Make, Just, Rake, or nothing. Check what actually exists (Makefile, Justfile, etc.) and replicate that choice. Also check CLAUDE.md or other docs for stated preferences — the user may prefer `just` even if a Makefile exists.

- **Deterministic copier.yml variable names**: Use `snake_case` for all copier.yml variable names. Derive them predictably: `use_<feature>` for boolean toggles. Don't invent synonyms across runs — if the source has "subprocess aggregation", the toggle is `use_subprocess_aggregation`, not `use_subprocess_composition`.

- **CLAUDE.md line budget**: The 25-line limit is strict. Count lines in your generated file and cut if over. The file layout section can be compressed by removing blank lines between entries.
