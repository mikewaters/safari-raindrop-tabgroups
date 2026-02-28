import { describe, test, expect } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../schema.json";

describe("JSON output schema", () => {
  let output: unknown;

  test("safari-tabgroups --json produces valid JSON", async () => {
    const proc = Bun.spawn(["bun", "run", "src/safari.ts", "--json", "--cached"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    output = JSON.parse(text);
  });

  test("output validates against schema.json", () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(output);
    if (!valid) {
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);
  });

  test("has at least one profile", () => {
    const data = output as { profiles: { name: string; tabGroups: unknown[] }[] };
    expect(data.profiles.length).toBeGreaterThanOrEqual(1);
  });

  test("first profile is Personal", () => {
    const data = output as { profiles: { name: string }[] };
    expect(data.profiles[0].name).toBe("Personal");
  });

  test("every tab has a non-empty title and url", () => {
    const data = output as {
      profiles: { tabGroups: { tabs: { title: string; url: string }[] }[] }[];
    };
    for (const profile of data.profiles) {
      for (const group of profile.tabGroups) {
        for (const tab of group.tabs) {
          expect(tab.title.length).toBeGreaterThan(0);
          expect(tab.url.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
