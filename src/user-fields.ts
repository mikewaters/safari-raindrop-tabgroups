/**
 * Human-authored field operations on tab groups / collections.
 *
 * `user_description` and `user_project` are owned by the human — sync paths
 * never overwrite them. These helpers are source-agnostic (safari/raindrop)
 * and used by both the CLI dispatcher (`show-group`, `update-group`) and the
 * Raycast `show-tab-group` command.
 */

import type { Database } from "bun:sqlite";

export const MAX_PROJECT_LENGTH = 255;

export interface UserFieldGroup {
  id: number;
  source: "safari" | "raindrop";
  name: string;
  profile: string | null;
  tab_count: number;
  last_active: string | null;
  user_description: string | null;
  user_project: string | null;
  user_updated_at: string | null;
  category: string | null;
  description: string | null;
  deleted_at: string | null;
}

export function getGroupBySource(
  db: Database,
  source: "safari" | "raindrop",
  name: string
): UserFieldGroup | null {
  const row = db
    .prepare(
      `SELECT g.id, g.source, g.name, g.profile, g.tab_count, g.last_active,
              g.user_description, g.user_project, g.user_updated_at,
              g.deleted_at,
              COALESCE(c.category, g.category) as category,
              COALESCE(c.description, g.description) as description
       FROM groups g
       LEFT JOIN group_classifications c ON g.active_version = c.id
       WHERE g.source = ? AND g.name = ? AND g.deleted_at IS NULL
       LIMIT 1`
    )
    .get(source, name) as UserFieldGroup | undefined;
  return row ?? null;
}

export interface UpdateUserFieldsInput {
  source: "safari" | "raindrop";
  name: string;
  project?: string | null; // string = set, null = clear, undefined = leave alone
  description?: string | null;
}

export function updateUserFields(db: Database, input: UpdateUserFieldsInput): UserFieldGroup {
  const existing = getGroupBySource(db, input.source, input.name);
  if (!existing) {
    const err: any = new Error(
      `Group not found: source=${input.source} name="${input.name}"`
    );
    err.code = "NOT_FOUND";
    throw err;
  }

  if (input.project !== undefined && input.project !== null) {
    if (input.project.length > MAX_PROJECT_LENGTH) {
      const err: any = new Error(
        `--project exceeds max length ${MAX_PROJECT_LENGTH} (got ${input.project.length})`
      );
      err.code = "VALIDATION";
      throw err;
    }
    if (input.project.includes("\n")) {
      const err: any = new Error(`--project must be a single line`);
      err.code = "VALIDATION";
      throw err;
    }
  }

  const now = new Date().toISOString();
  const sets: string[] = [];
  const args: any[] = [];

  if (input.project !== undefined) {
    sets.push("user_project = ?");
    args.push(input.project);
  }
  if (input.description !== undefined) {
    sets.push("user_description = ?");
    args.push(input.description);
  }

  if (sets.length === 0) {
    return existing;
  }

  sets.push("user_updated_at = ?");
  args.push(now);
  args.push(existing.id);

  db.prepare(`UPDATE groups SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  return getGroupBySource(db, input.source, input.name)!;
}

