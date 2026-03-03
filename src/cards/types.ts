export interface CollectionCard {
  definition: string;
  includes: string[];
  excludes: string[];
  keyphrases: string[];
  representative_entities: string[];
}

export interface StoredCollectionCardVersion extends CollectionCard {
  id: number;
  group_id: number;
  version: number;
  generated_by: "system" | "manual";
  model_version: string | null;
  last_generated_at: string | null;
  last_reviewed_at: string | null;
  author: string | null;
  created_at: string;
  card_schema_version: number;
}

export interface CollectionCardMatch {
  group: string;
  source: string;
  score: number;
  reason: string;
  rawScore?: number;
  lastActive?: string | null;
}

export interface CardScoreBreakdown {
  definition: number;
  keyphrases: number;
  includes: number;
  excludes: number;
  domain: number;
  total: number;
}

export function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export function serializeStringArray(values: string[] | null | undefined): string {
  return JSON.stringify(values ?? []);
}

export function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseCollectionCard(row: {
  definition?: string | null;
  includes_json?: string | null;
  excludes_json?: string | null;
  keyphrases_json?: string | null;
  representative_entities_json?: string | null;
}): CollectionCard {
  return {
    definition: row.definition || "",
    includes: parseJsonStringArray(row.includes_json),
    excludes: parseJsonStringArray(row.excludes_json),
    keyphrases: parseJsonStringArray(row.keyphrases_json),
    representative_entities: parseJsonStringArray(row.representative_entities_json),
  };
}

export function stringifyCollectionCard(card: CollectionCard): {
  includes_json: string;
  excludes_json: string;
  keyphrases_json: string;
  representative_entities_json: string;
} {
  return {
    includes_json: serializeStringArray(card.includes),
    excludes_json: serializeStringArray(card.excludes),
    keyphrases_json: serializeStringArray(card.keyphrases),
    representative_entities_json: serializeStringArray(card.representative_entities),
  };
}

export function cardSearchText(row: {
  name?: string | null;
  definition?: string | null;
  includes_json?: string | null;
  excludes_json?: string | null;
  keyphrases_json?: string | null;
  representative_entities_json?: string | null;
}): string {
  const card = parseCollectionCard(row);
  return [
    row.name || "",
    card.definition,
    ...card.includes,
    ...card.excludes,
    ...card.keyphrases,
    ...card.representative_entities,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
