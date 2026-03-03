import { describe, expect, test } from "bun:test";
import schema from "../describe.schema.json";

describe("Collection Card schema metadata", () => {
  test("requires the Collection Card fields", () => {
    const parsedCard = (schema as any).definitions.ParsedCard;
    expect(parsedCard.required).toEqual([
      "definition",
      "includes",
      "keyphrases",
      "representative_entities",
    ]);
  });

  test("makes excludes optional and conservative", () => {
    const parsedCard = (schema as any).definitions.ParsedCard;
    const excludes = parsedCard.properties.excludes;
    expect(parsedCard.required).not.toContain("excludes");
    expect(excludes.minItems).toBe(0);
    expect(excludes.maxItems).toBe(3);
  });

  test("enforces collection card minimum sizes", () => {
    const properties = (schema as any).definitions.ParsedCard.properties;
    expect(properties.definition.minLength).toBe(200);
    expect(properties.includes.minItems).toBe(3);
    expect(properties.keyphrases.minItems).toBe(5);
    expect(properties.representative_entities.minItems).toBe(3);
  });
});
