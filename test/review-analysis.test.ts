import { describe, expect, test } from "bun:test";
import {
  diffCollectionCards,
  evaluateCollectionDrift,
  summarizeMetrics,
} from "../src/review/analysis";

describe("review analysis helpers", () => {
  test("evaluateCollectionDrift queues high-drift collections", () => {
    const result = evaluateCollectionDrift({
      previousCentroidSimilarity: 0.55,
      previousKeywords: ["agents", "sdk", "tooling"],
      nextKeywords: ["recipes", "cooking", "baking"],
      confusionCount: 3,
      feedbackCount: 4,
      ambiguityRate: 0.5,
      driftThreshold: 0.28,
      centroidShiftThreshold: 0.2,
      keywordShiftThreshold: 0.35,
      confusionThreshold: 2,
      ambiguityThreshold: 0.4,
    });

    expect(result.shouldQueue).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0.28);
  });

  test("evaluateCollectionDrift does not queue the first baseline build", () => {
    const result = evaluateCollectionDrift({
      previousCentroidSimilarity: null,
      previousKeywords: [],
      nextKeywords: ["agents", "sdk", "tooling"],
      confusionCount: 0,
      feedbackCount: 0,
      ambiguityRate: 0,
      driftThreshold: 0.28,
      centroidShiftThreshold: 0.2,
      keywordShiftThreshold: 0.35,
      confusionThreshold: 2,
      ambiguityThreshold: 0.4,
    });

    expect(result.shouldQueue).toBe(false);
    expect(result.score).toBe(0);
  });

  test("diffCollectionCards reports changed fields only", () => {
    const diffs = diffCollectionCards(
      {
        definition: "Docs and SDK references.",
        includes_json: JSON.stringify(["sdk", "api"]),
        excludes_json: JSON.stringify(["sales"]),
        keyphrases_json: JSON.stringify(["agents", "sdk"]),
        representative_entities_json: JSON.stringify(["OpenAI"]),
      },
      {
        definition: "Docs, SDK references, and integration examples.",
        includes_json: JSON.stringify(["sdk", "api"]),
        excludes_json: JSON.stringify(["sales"]),
        keyphrases_json: JSON.stringify(["agents", "sdk", "integration"]),
        representative_entities_json: JSON.stringify(["OpenAI"]),
      }
    );

    expect(diffs.map((diff) => diff.field)).toEqual(["definition", "keyphrases"]);
  });

  test("summarizeMetrics computes the expected ratios", () => {
    const summary = summarizeMetrics(
      [
        {
          top_match_group: "Agents",
          match_groups: ["Agents", "Docs"],
          expected_group: "Agents",
          feedback_type: "correct",
        },
        {
          top_match_group: "Docs",
          match_groups: ["Docs", "Agents"],
          expected_group: "Agents",
          feedback_type: "wrong_match",
        },
      ],
      10,
      4,
      2,
      20
    );

    expect(summary.top1Accuracy).toBeCloseTo(0.5, 5);
    expect(summary.top5Recall).toBeCloseTo(1, 5);
    expect(summary.ambiguityRate).toBeCloseTo(0.4, 5);
    expect(summary.overrideRate).toBeCloseTo(0.5, 5);
    expect(summary.driftFrequency).toBeCloseTo(0.1, 5);
  });
});
