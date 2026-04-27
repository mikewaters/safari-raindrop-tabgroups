import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resolveGroup } from "../src/lib";
import { getGroupBySource, updateUserFields, MAX_PROJECT_LENGTH } from "../src/user-fields";

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "stg-test-"));
  return openDb(join(dir, "bookmarks.db"));
}

function insertSafariGroup(db: Database, source_id: string, name: string): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO groups (source, source_id, name, profile, tab_count, last_active, created_at, updated_at)
       VALUES ('safari', ?, ?, NULL, 0, ?, ?, ?)`
    )
    .run(source_id, name, now, now, now);
  return Number(info.lastInsertRowid);
}

describe("user fields", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("schema includes user fields and deleted_at", () => {
    const cols = db.prepare("PRAGMA table_info(groups)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("user_description");
    expect(names).toContain("user_project");
    expect(names).toContain("user_updated_at");
    expect(names).toContain("deleted_at");
  });

  test("updateUserFields sets and clears project/description", () => {
    insertSafariGroup(db, "g1", "Group One");

    const set = updateUserFields(db, {
      source: "safari",
      name: "Group One",
      project: "proj-a",
      description: "some notes",
    });
    expect(set.user_project).toBe("proj-a");
    expect(set.user_description).toBe("some notes");
    expect(set.user_updated_at).not.toBeNull();

    const cleared = updateUserFields(db, {
      source: "safari",
      name: "Group One",
      project: null,
      description: null,
    });
    expect(cleared.user_project).toBeNull();
    expect(cleared.user_description).toBeNull();
  });

  test("project length over MAX rejected", () => {
    insertSafariGroup(db, "g1", "Group One");
    expect(() =>
      updateUserFields(db, {
        source: "safari",
        name: "Group One",
        project: "x".repeat(MAX_PROJECT_LENGTH + 1),
      })
    ).toThrow();
  });

  test("project containing newline rejected", () => {
    insertSafariGroup(db, "g1", "Group One");
    expect(() =>
      updateUserFields(db, {
        source: "safari",
        name: "Group One",
        project: "line1\nline2",
      })
    ).toThrow();
  });

  test("missing group throws NOT_FOUND", () => {
    let caught: any;
    try {
      updateUserFields(db, { source: "safari", name: "missing", project: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("NOT_FOUND");
  });

  test("getGroupBySource ignores soft-deleted rows", () => {
    insertSafariGroup(db, "g1", "Group One");
    db.prepare("UPDATE groups SET deleted_at = ? WHERE source_id = 'g1'").run(new Date().toISOString());
    expect(getGroupBySource(db, "safari", "Group One")).toBeNull();
  });

  test("resolveGroup ignores soft-deleted by default and surfaces with includeDeleted", () => {
    insertSafariGroup(db, "g1", "Group One");
    db.prepare("UPDATE groups SET deleted_at = ? WHERE source_id = 'g1'").run(new Date().toISOString());
    expect(resolveGroup(db, "Group One")).toBeNull();
    expect(resolveGroup(db, "Group One", "*", { includeDeleted: true })).not.toBeNull();
  });

  test("user fields survive a sync-style UPDATE", () => {
    insertSafariGroup(db, "g1", "Group One");
    updateUserFields(db, {
      source: "safari",
      name: "Group One",
      project: "kept",
      description: "kept-notes",
    });

    // Simulate the sync UPDATE path (mirrors src/index.ts updateGroup statement)
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE groups SET name = ?, profile = ?, tab_count = ?, last_active = ?,
        created_at = COALESCE(?, created_at), updated_at = ?,
        deleted_at = NULL
       WHERE source = 'safari' AND source_id = 'g1'`
    ).run("Group One", "Default", 5, now, null, now);

    const after = getGroupBySource(db, "safari", "Group One");
    expect(after?.user_project).toBe("kept");
    expect(after?.user_description).toBe("kept-notes");
    expect(after?.tab_count).toBe(5);
  });

  test("soft-delete then revive clears deleted_at while preserving user fields", () => {
    insertSafariGroup(db, "g1", "Group One");
    updateUserFields(db, { source: "safari", name: "Group One", project: "p" });

    // Soft-delete (mirrors sync stale-removal path)
    db.prepare("UPDATE groups SET deleted_at = ? WHERE source_id = 'g1'").run(new Date().toISOString());
    expect(getGroupBySource(db, "safari", "Group One")).toBeNull();

    // Revive via the same UPDATE that sync would issue on re-discovery
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE groups SET name = ?, profile = ?, tab_count = ?, last_active = ?,
        created_at = COALESCE(?, created_at), updated_at = ?,
        deleted_at = NULL
       WHERE source = 'safari' AND source_id = 'g1'`
    ).run("Group One", null, 0, now, null, now);

    const revived = getGroupBySource(db, "safari", "Group One");
    expect(revived).not.toBeNull();
    expect(revived?.user_project).toBe("p");
  });
});
