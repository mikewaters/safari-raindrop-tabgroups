import { parseCollectionCard, type CollectionCard } from "../cards/types";

export interface DriftAssessmentInput {
  previousCentroidSimilarity: number | null;
  previousKeywords: string[];
  nextKeywords: string[];
  confusionCount: number;
  feedbackCount: number;
  ambiguityRate: number;
  driftThreshold: number;
  centroidShiftThreshold: number;
  keywordShiftThreshold: number;
  confusionThreshold: number;
  ambiguityThreshold: number;
}

export interface DriftAssessment {
  score: number;
  centroidShift: number;
  keywordShift: number;
  confusionRate: number;
  ambiguityRate: number;
  shouldQueue: boolean;
  reasons: string[];
}

export interface CardDiff {
  field: keyof CollectionCard;
  before: string | string[];
  after: string | string[];
}

export interface MetricInputRow {
  top_match_group: string | null;
  match_groups: string[];
  expected_group: string | null;
  feedback_type: string;
}

export interface MetricsSummary {
  evaluatedCount: number;
  top1Accuracy: number;
  top5Recall: number;
  ambiguityRate: number;
  overrideRate: number;
  driftFrequency: number;
  openReviewCount: number;
  totalGroups: number;
}

export function parseSignature(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function summarizeTopTerms(
  counts: Map<string, number>,
  limit = 12
): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([term]) => term);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  return intersection / union.size;
}

export function evaluateCollectionDrift(
  input: DriftAssessmentInput
): DriftAssessment {
  const hasPreviousBaseline =
    input.previousCentroidSimilarity != null || input.previousKeywords.length > 0;
  const centroidShift =
    !hasPreviousBaseline || input.previousCentroidSimilarity == null
      ? 0
      : Math.max(0, 1 - Math.max(0, input.previousCentroidSimilarity));
  const keywordShift = Math.max(
    0,
    hasPreviousBaseline
      ? 1 - jaccardSimilarity(input.previousKeywords, input.nextKeywords)
      : 0
  );
  const confusionRate =
    input.feedbackCount > 0 ? input.confusionCount / input.feedbackCount : 0;
  const score = Math.max(
    0,
    Math.min(
      1,
      centroidShift * 0.45 +
        keywordShift * 0.25 +
        confusionRate * 0.2 +
        input.ambiguityRate * 0.1
    )
  );

  const reasons: string[] = [];
  if (centroidShift >= input.centroidShiftThreshold) {
    reasons.push(`centroid shift ${centroidShift.toFixed(3)}`);
  }
  if (keywordShift >= input.keywordShiftThreshold) {
    reasons.push(`keyword shift ${keywordShift.toFixed(3)}`);
  }
  if (input.confusionCount >= input.confusionThreshold) {
    reasons.push(`feedback confusion ${input.confusionCount}`);
  }
  if (input.ambiguityRate >= input.ambiguityThreshold) {
    reasons.push(`ambiguity rate ${input.ambiguityRate.toFixed(3)}`);
  }
  if (score >= input.driftThreshold && reasons.length === 0) {
    reasons.push(`composite drift ${score.toFixed(3)}`);
  }

  return {
    score,
    centroidShift,
    keywordShift,
    confusionRate,
    ambiguityRate: input.ambiguityRate,
    shouldQueue: score >= input.driftThreshold || reasons.length > 0,
    reasons,
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function diffCollectionCards(
  beforeRow: {
    definition?: string | null;
    includes_json?: string | null;
    excludes_json?: string | null;
    keyphrases_json?: string | null;
    representative_entities_json?: string | null;
  },
  afterRow: {
    definition?: string | null;
    includes_json?: string | null;
    excludes_json?: string | null;
    keyphrases_json?: string | null;
    representative_entities_json?: string | null;
  }
): CardDiff[] {
  const before = parseCollectionCard(beforeRow);
  const after = parseCollectionCard(afterRow);
  const diffs: CardDiff[] = [];

  if (before.definition !== after.definition) {
    diffs.push({
      field: "definition",
      before: before.definition,
      after: after.definition,
    });
  }

  const arrayFields: (keyof Omit<CollectionCard, "definition">)[] = [
    "includes",
    "excludes",
    "keyphrases",
    "representative_entities",
  ];

  for (const field of arrayFields) {
    if (!arraysEqual(before[field], after[field])) {
      diffs.push({
        field,
        before: before[field],
        after: after[field],
      });
    }
  }

  return diffs;
}

export function summarizeMetrics(
  rows: MetricInputRow[],
  matchLogCount: number,
  ambiguousMatchCount: number,
  openReviewCount: number,
  totalGroups: number
): MetricsSummary {
  let top1Hits = 0;
  let top5Hits = 0;
  let overrides = 0;
  let evaluatedCount = 0;

  for (const row of rows) {
    if (!row.expected_group) continue;
    evaluatedCount++;

    if (row.top_match_group === row.expected_group) {
      top1Hits++;
    }

    if (row.match_groups.includes(row.expected_group)) {
      top5Hits++;
    }

    if (row.feedback_type === "wrong_match" || row.feedback_type === "missing_match") {
      overrides++;
    }
  }

  return {
    evaluatedCount,
    top1Accuracy: evaluatedCount > 0 ? top1Hits / evaluatedCount : 0,
    top5Recall: evaluatedCount > 0 ? top5Hits / evaluatedCount : 0,
    ambiguityRate: matchLogCount > 0 ? ambiguousMatchCount / matchLogCount : 0,
    overrideRate: evaluatedCount > 0 ? overrides / evaluatedCount : 0,
    driftFrequency: totalGroups > 0 ? openReviewCount / totalGroups : 0,
    openReviewCount,
    totalGroups,
  };
}
