# Copier Template Guide

Copier is a CLI tool that scaffolds projects from template repositories. Install with `pipx install copier` or `uv tool install copier`.

## Template Structure

A Copier template is a git repo containing:

```
my-template/
├── copier.yml              # Questions and configuration
├── {{ project_slug }}/     # Subdirectory with project files (Jinja2-templated name)
│   ├── CLAUDE.md.jinja
│   ├── package.json.jinja
│   └── src/
│       └── main.ts.jinja
└── README.md               # Template documentation (for template maintainers)
```

## copier.yml

Defines questions asked during `copier copy` and template metadata.

```yaml
_min_copier_version: "9.1.0"
_subdirectory: "{{ project_slug }}"    # Render only this subdirectory into the target

project_name:
  type: str
  help: "Human-readable project name"

project_slug:
  type: str
  default: "{{ project_name | lower | replace(' ', '-') }}"
  help: "Directory and package name (kebab-case)"

description:
  type: str
  help: "One-line project description"
  default: ""

# Feature toggles for optional patterns
use_sqlite:
  type: bool
  default: true
  help: "Include SQLite database layer"

use_config:
  type: bool
  default: true
  help: "Include TOML config with XDG path resolution"
```

### Question types

- `str`: free text
- `bool`: yes/no toggle
- `int` / `float`: numeric
- `yaml`: complex data (rarely needed)

### Computed values

Use `when: false` to create variables derived from other answers:

```yaml
project_upper:
  type: str
  default: "{{ project_slug | upper | replace('-', '_') }}"
  when: false
```

## Jinja2 Templating

Files with `.jinja` extension are rendered through Jinja2. The extension is stripped in the output.

### In file contents

```typescript
// {{ project_slug }}/src/main.ts.jinja
const PROGRAM_NAME = "{{ project_slug }}";
const VERSION = "0.1.0";
{% if use_sqlite %}
import { Database } from "bun:sqlite";
{% endif %}
```

### In file/directory names

```
{{ project_slug }}/        →  my-cool-tool/
config.{{ project_slug }}.toml.jinja  →  config.my-cool-tool.toml
```

### Conditional files

Entire files can be conditional:

```yaml
# copier.yml
_templates_suffix: .jinja
```

Then use Jinja2 `{% if %}` at the top of a file, or use `_exclude` patterns:

```yaml
_exclude:
  - "{% if not use_sqlite %}**/db.ts.jinja{% endif %}"
```

Or simpler: wrap the entire file content in `{% if use_sqlite %}...{% endif %}` — Copier will create an empty file, which you can `.gitignore` or handle with a post-generation hook.

## Usage

```bash
# Scaffold from a git repo
copier copy gh:user/my-template ./new-project

# Scaffold from a local template
copier copy /path/to/template ./new-project

# Update an existing project when the template changes
copier update
```

## Key Principles for Template Design

1. **Minimal questions**: Every question adds friction. Bake in hard constraints, only ask about genuine choices.
2. **Sensible defaults**: Every question should have a default that works for the common case.
3. **Light templating**: Replace only project-specific values (name, slug, paths). Keep code readable.
4. **Working output**: `copier copy` with all defaults should produce a project that builds and runs.
5. **`_subdirectory`**: Always use this so the template repo root stays clean for documentation and maintenance.
