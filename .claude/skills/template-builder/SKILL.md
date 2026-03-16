---
name: template-builder
description: >-
  Build a Copier template from architecture constraints and a source codebase.
  Use this skill when the user has architecture constraints (from the
  architecture-extractor skill or written manually) and wants to produce a
  reusable project template. Also use when someone says "build a template",
  "create a copier template", "templatize this", or "make a starter kit".
  This skill takes a constraints file as input — run architecture-extractor
  first if one doesn't exist.
---

# Template Builder

You take an architecture constraints document and a source codebase and produce a **Copier template** — a git repo that scaffolds new projects with those architecture decisions baked in via CLAUDE.md, architecture reference files, skeleton code, and ecosystem-appropriate config.

## Inputs

This skill requires two things:

1. **Architecture constraints file** — A markdown file containing CLAUDE.md content, architecture decisions, and skeleton file candidates. Produced by the `architecture-extractor` skill, or written manually. The user will tell you where it is (typically `.claude/architecture-constraints.md`).

2. **Access to the source codebase** — To read skeleton file candidates and config files for templatization.

If no constraints file exists, tell the user to run the `architecture-extractor` skill first (or use `/architecture-extractor`).

## Output location

Create a temp workspace for the template output:
```bash
WORKSPACE=$(mktemp -d)
```

Write all generated files to `$WORKSPACE/`. Print the workspace path so the user can find it.

## Workflow

### Step 1: Read the constraints file

Parse the architecture constraints document. Extract:
- The CLAUDE.md section
- The architecture decisions (for architecture.md)
- The skeleton file candidates
- The metadata (language, runtime, build tool, etc.)

### Step 2: Select the artifact set

Consult `references/artifact-selection.md`. The ecosystem determines which config files, build tools, and skeleton patterns to include:
- Always: CLAUDE.md, .claude/architecture.md, .gitignore, copier.yml, README.md
- Ecosystem-specific: package.json (TS), pyproject.toml (Python), go.mod (Go), etc.
- Build tool: Makefile, Justfile, or none (whatever the source uses)
- Skeleton source files based on the candidates list

### Step 3: Templatize skeleton files

Read the recommended skeleton files from the source codebase. Create Jinja2-templated versions:
- Replace project-specific names with `{{ project_slug }}`
- Replace config file paths, binary names, database names
- Keep structural code intact — files should read as real code, not Jinja2 soup
- Only templatize: project name/slug, config paths, binary names, database file names

See `references/copier-guide.md` for Copier template mechanics.

### Step 4: Generate copier.yml

Create the Copier configuration:
- **Always ask**: project_name, project_slug (derived), description
- **Feature toggles**: `use_<feature>` booleans for optional patterns detected in the constraints (e.g., `use_sqlite`, `use_config`, `use_openrouter`)
- Hard constraints are baked in, not questioned
- Every question must have a sensible default

Use `snake_case` for all variable names. Derive toggle names from the codebase's own terminology.

### Step 5: Generate the template README

Create `README.md` at the template root (next to copier.yml). Include:
1. What the template produces (one sentence)
2. Prerequisites (copier, runtime, build tool)
3. The `copier copy` command
4. List of questions and what they control
5. Description of the generated file layout

See `references/artifact-selection.md` for the full README spec.

### Step 6: Convert CLAUDE.md and architecture.md to Jinja2

The CLAUDE.md and architecture.md from the constraints file need to be templatized:
- Replace the project name with `{{ project_name }}`
- Replace app-specific paths with `{{ project_slug }}`
- Wrap optional sections (SQLite, API integration, subprocess composition) in `{% if use_<feature> %}` conditionals
- Update file pointers to reference skeleton files in the generated project

### Step 7: Assemble the template

Create the Copier template structure:
```
$WORKSPACE/
├── copier.yml
├── README.md
└── project/                    # _subdirectory: "project"
    ├── CLAUDE.md.jinja
    ├── .claude/
    │   └── architecture.md.jinja
    ├── src/
    │   ├── main.ts.jinja       # (or .py, .go, .rs — ecosystem-dependent)
    │   └── config.ts.jinja
    ├── Makefile.jinja           # (or Justfile, or omit)
    ├── package.json.jinja       # (ecosystem-dependent)
    ├── tsconfig.json            # (if TypeScript)
    ├── .gitignore
    └── config.toml.jinja        # (if applicable)
```

Use `_subdirectory: "project"` in copier.yml so the template root stays clean.

### Step 8: Validate

Before presenting to the user:
- CLAUDE.md is under 25 lines
- Every file pointer in architecture.md resolves to an actual skeleton file
- copier.yml has sensible defaults for all questions
- If `copier` is available, run `copier copy --defaults` into a temp directory and check the output

### Step 9: Present to the user

Show:
1. The template directory tree
2. The copier.yml questions and defaults
3. A summary of skeleton files and what pattern each demonstrates
4. The workspace path

## Important notes

- The template is a Copier git repo. The user will `git init` and push it, then `copier copy` from it.
- CLAUDE.md file pointers reference skeleton files within the GENERATED project, not the source codebase.
- Skeleton files should work as real code after `copier copy`, not just be documentation.
- Use `_subdirectory: "project"` (fixed name) — NOT `{{ project_slug }}` (causes copier resolution issues).

## Common pitfalls

- **Skeleton/constraint consistency**: If CLAUDE.md says "use runtime X's native APIs", skeleton files must comply. Audit every skeleton against the constraints before finalizing.
- **Detect, don't assume, the build tool**: Use whatever the constraints file says the source codebase uses. Also check for user preferences (e.g., `just` over `make`).
- **Deterministic toggle names**: Use `snake_case`, derived from the codebase's terminology. If the source says "subprocess aggregation", the toggle is `use_subprocess_aggregation`.
- **CLAUDE.md line budget**: 25-line limit is strict. Count lines.
- **Don't require --trust**: Avoid `_jinja_extensions` in copier.yml. Use content-level `{% if %}` wrapping instead of `_exclude` patterns.
