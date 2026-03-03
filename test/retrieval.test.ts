import { describe, expect, test } from "bun:test";
import {
  embedText,
  embedTextsWithConfig,
  extractItemSignals,
  meanVector,
  normalizeUrl,
  selectExemplars,
} from "../src/retrieval/local-embedding";

describe("retrieval helpers", () => {
  test("normalizeUrl strips hash and trailing slash", () => {
    expect(normalizeUrl("https://Example.com/path/#section")).toBe(
      "https://example.com/path"
    );
  });

  test("embedText is deterministic and normalized", () => {
    const a = embedText("agent memory orchestration", 16);
    const b = embedText("agent memory orchestration", 16);
    expect(a).toEqual(b);

    const magnitude = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  test("embedTextsWithConfig uses the hash backend deterministically", async () => {
    const [a, b] = await embedTextsWithConfig(
      ["agent memory orchestration", "agent memory orchestration"],
      {
        embedding_model_version: "local-hash-v1",
        vector_dimensions: 16,
      }
    );
    expect(a).toEqual(b);
  });

  test("extractItemSignals derives keyphrases and entities", () => {
    const result = extractItemSignals(
      "OpenAI Agents SDK Docs",
      "https://platform.openai.com/docs/guides/agents"
    );
    expect(result.keyphrases.length).toBeGreaterThan(0);
    expect(result.entities).toContain("OpenAI");
  });

  test("selectExemplars picks the closest vectors to the centroid", () => {
    const vectors = [
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0, 1, 0],
    ];
    const centroid = meanVector(vectors);
    const exemplars = selectExemplars(vectors, centroid, 2);
    expect(exemplars.length).toBe(2);
    expect(exemplars).toContainEqual([0.9, 0.1, 0]);
  });
});
