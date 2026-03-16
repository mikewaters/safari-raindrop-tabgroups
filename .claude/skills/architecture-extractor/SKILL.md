---
name: architecture-extractor
description: >-
  Extract or update architecture decisions from a codebase. Use this skill when
  the user wants to analyze a codebase's architecture, extract patterns and
  conventions, document architecture decisions, or produce agent-steering
  constraint files (CLAUDE.md / architecture.md). Also use when someone says
  "analyze this architecture", "extract constraints", "document the patterns
  here", "what are the architecture decisions in this codebase", "update
  constraints", "refresh architecture", "validate patterns", "check if
  constraints still hold", or "are my architecture decisions still accurate".
---

# Architecture Extractor

You analyze a mature codebase, extract the architecture decisions that make it internally consistent, and produce a **constraints document** — a structured markdown file containing both a compact CLAUDE.md section and a detailed architecture reference.

The output steers future agents through progressive disclosure:
- **CLAUDE.md section**: top 5-10 hardest constraints in imperative form
- **Architecture section**: full decisions organized by concern, each with a brief "why" and file pointer
- **Design Philosophy**: 2-3 paragraphs explaining what kind of project this is and how the pieces fit together

This skill is **domain-agnostic** — it works in TypeScript, Python, Go, Rust, or any other ecosystem.

## Output

Write the constraints document to a file in the project root:

```
.claude/architecture-constraints.md
```

This file is the primary deliverable. It can be used directly (copy sections into CLAUDE.md and .claude/architecture.md) or consumed by downstream tools like a template builder.

## Workflow

### Phase 0: Mode selection

Check if `.claude/architecture-constraints.md` already exists.

**No existing file** → proceed with Phase 1 (extract from scratch).

**Existing file found** → read it and ask the user which mode they want:

1. **Discover new patterns** — Re-run the research agents with awareness of existing decisions. Find what's new, what's changed, and what's been removed.
2. **Validate existing patterns** — Check each documented decision against the current codebase. Report which still hold, which have weakened, and which are violated.
3. **Both** — Validate first, then discover with validation results folded in.

Then proceed to the appropriate phase below.

---

### Extract from scratch (no existing file)

#### Phase 1: Research the codebase

Launch 4 subagents in parallel. Read the agent prompts in `agents/` (relative to this skill) before spawning them.

**Subagent A — Structure Analyzer** (read `agents/structure-analyzer.md`):
Maps the codebase: language, runtime, package manager, build system, dependency manifest, command/module pattern, testing and linting tools. Outputs structured JSON.

**Subagent B — Pattern Extractor** (read `agents/pattern-extractor.md`):
Reads source files and identifies recurring code patterns: arg parsing, CLI interface design, tool composition, config loading, data access, error handling, logging, API integration, module organization. For each pattern: canonical file+line, frequency, variations. Outputs a list of patterns with evidence.

**Subagent C — Convention Detector** (read `agents/convention-detector.md`):
Examines CLAUDE.md, AGENTS.md, skills, README, CONTRIBUTING, docs, git log, linting config. Identifies naming conventions, commit conventions, documented decisions (ADRs). Outputs a list of conventions with sources.

**Subagent D — Design Philosophy Analyzer** (read `agents/philosophy-analyzer.md`):
Reads the codebase holistically to identify the design intent: who are the tools for (agents, humans, both)? How do the pieces compose? What's the deployment model? What's the configuration philosophy? Outputs a philosophy summary, composition model, and philosophy-driven requirements. Pass it the path to `references/design-philosophies.md` for known design approaches to look for.

#### Phase 2: Synthesize

Spawn a **Synthesizer** subagent (read `agents/synthesizer.md`) in **extract mode**. Pass it:
- The four research outputs from Phase 1
- The path to `references/constraint-format.md`

The synthesizer classifies every finding (hard constraint vs. pattern vs. convention), writes the CLAUDE.md and architecture.md content, and returns structured JSON including `uncertain_decisions`.

#### Phase 3: Assemble the output document

Take the synthesizer's JSON output and assemble the constraints document:

```markdown
# Architecture Constraints

> Extracted from <codebase name> on <date>

## CLAUDE.md

<the compact constraints section, ready to paste into a project's CLAUDE.md>

## Architecture Decisions

<the full architecture.md content, starting with Design Philosophy>

## Metadata

- **Source codebase**: <path>
- **Decisions extracted**: <count>
- **Hard constraints**: <count>
- **Patterns**: <count>
- **Conventions**: <count>

### Uncertain Decisions

<list of decisions the synthesizer wasn't sure about>

### Skeleton File Candidates

<list of files recommended as skeleton templates, with patterns each demonstrates>
```

Write this to `.claude/architecture-constraints.md`.

#### Phase 4: Present to the user

Show the user:
1. The CLAUDE.md section (full text)
2. A summary of the architecture decisions by concern area
3. Any uncertain decisions that need their input
4. The skeleton file candidates (useful if they want to build a template later)

---

### Discover new patterns (existing file found)

#### Phase D1: Research the codebase

Same as Phase 1 above — launch all 4 research subagents in parallel.

#### Phase D2: Synthesize with merge

Spawn the **Synthesizer** subagent in **update mode** (read the "Update Mode" section of `agents/synthesizer.md`). Pass it:
- The four research outputs from Phase D1
- The path to `references/constraint-format.md`
- The existing constraints document (full text of `.claude/architecture-constraints.md`)

The synthesizer diffs the existing inventory against the new research, produces a merged document, and returns a `changes_summary` showing what was added, updated, flagged for removal, or reclassified.

#### Phase D3: Assemble the updated document

Take the synthesizer's output and write the updated `.claude/architecture-constraints.md`. The document format is the same as extract mode, but the Resolved Decisions section is preserved from the existing file.

#### Phase D4: Present changes to the user

Show the user:
1. The `changes_summary` — what's new, what changed, what might need removal
2. Any new uncertain decisions
3. The updated CLAUDE.md section (if it changed)
4. Decisions flagged for removal (the user decides whether to keep or drop them)

---

### Validate existing patterns (existing file found)

#### Phase V1: Validate

Spawn the **Validator** subagent (read `agents/validator.md`). Pass it:
- The path to `.claude/architecture-constraints.md`
- The codebase root path

The validator checks every documented decision against the current codebase and reports: holds, weakened, violated, or obsolete. It also checks file pointer validity.

#### Phase V2: Present validation results

Show the user:
1. A summary: how many decisions hold, weakened, violated, obsolete
2. Details for any non-"holds" decisions — what changed and where
3. Broken file pointers with suggested fixes
4. Recommendations: which decisions to update, remove, or investigate

If the user wants to act on the results (fix violations, update evidence, remove obsolete decisions), update the constraints document accordingly.

---

### Both (validate then discover)

#### Phase B1: Validate

Run Phase V1 (spawn the validator). Collect results.

#### Phase B2: Research

Run Phase D1 (spawn all 4 research subagents).

#### Phase B3: Synthesize with merge + validation

Spawn the **Synthesizer** in **update mode**. Pass it:
- The four research outputs
- The existing constraints document
- The validation results from Phase B1
- The path to `references/constraint-format.md`

The synthesizer uses the validation results to inform its merge — weakened patterns get updated evidence, violated constraints get flagged, obsolete decisions get marked for removal.

#### Phase B4: Present

Show the user the combined results:
1. Validation summary (holds/weakened/violated/obsolete)
2. Changes summary (added/updated/flagged/reclassified)
3. Updated CLAUDE.md section
4. Items needing user decision (removals, violations, new uncertain decisions)

## Important notes

- Hard constraints use imperative language ("Use X. Never use Y.")
- Every decision in the architecture section includes a brief "why" so agents can reason about edge cases.
- File pointers reference files in the SOURCE codebase (since this is analysis, not template generation).
- When in doubt about classification, err toward pattern over hard constraint. Overly rigid constraints frustrate users.
- Detect the actual build tool (Makefile, Justfile, etc.), don't assume.

## Common pitfalls

- **Constraint/code consistency**: If you say "never use Node.js APIs", verify the codebase actually avoids them. Check for exceptions (Bun projects often use node:fs, node:path, node:os).
- **Over-extraction**: Aim for 15-25 decisions total. Prioritize decisions that would be hardest for an agent to discover on its own.
- **Missing philosophy**: The Design Philosophy section is the most valuable part. Don't skip it. An agent that understands "why" makes better judgment calls than one that only knows "what".
