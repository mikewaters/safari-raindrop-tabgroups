import { describe, expect, test } from "bun:test";
import schema from "../describe.schema.json";

describe("Collection Card schema metadata", () => {
  test("requires the Collection Card fields", () => {
    const parsedCard = (schema as any).definitions.ParsedCard;
    expect(parsedCard.required).toEqual([
      "definition",
      "includes",
      "excludes",
      "keyphrases",
      "representative_entities",
    ]);
  });

  test("enforces phase 1 minimum sizes", () => {
    const properties = (schema as any).definitions.ParsedCard.properties;
    expect(properties.definition.minLength).toBe(200);
    expect(properties.includes.minItems).toBe(3);
    expect(properties.excludes.minItems).toBe(2);
    expect(properties.keyphrases.minItems).toBe(5);
    expect(properties.representative_entities.minItems).toBe(3);
  });
});
