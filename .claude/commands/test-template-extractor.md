You are testing the `template-extractor` skill. Run two test cases in parallel, each in a separate subagent.

## Setup

Create a temp workspace:
```bash
WORKSPACE=$(mktemp -d)
echo "Workspace: $WORKSPACE"
mkdir -p "$WORKSPACE/eval-extract-template/outputs" "$WORKSPACE/eval-vague-prompt/outputs"
```

## Test Cases

Launch both subagents in parallel with `run_in_background: true`:

### Eval 1: Direct prompt
- **Prompt to execute**: "Extract a template from this codebase"
- **Skill path**: Read and follow `.claude/skills/template-extractor/SKILL.md`
- **Output dir**: `$WORKSPACE/eval-extract-template/outputs/`
- **Working directory**: This repo's root

### Eval 2: Vague prompt
- **Prompt to execute**: "Templatize this project so we can spin up similar tools"
- **Skill path**: Read and follow `.claude/skills/template-extractor/SKILL.md`
- **Output dir**: `$WORKSPACE/eval-vague-prompt/outputs/`
- **Working directory**: This repo's root

## Rules

- Do NOT modify any files in the source codebase — only create files in the output directories
- Each subagent should read the SKILL.md and follow its full workflow (reading agent prompts, spawning research subagents, synthesis, etc.)

## After both complete

List the generated files from both evals and compare:
1. Show both CLAUDE.md files side by side
2. Show both architecture.md files
3. Note any differences in decisions extracted, file counts, or structure
4. Report timing and token usage for each

Print the workspace path so the user can inspect the outputs.
