import type { Database } from "bun:sqlite";

// ─── Strategy Types ─────────────────────────────────────────────────────────

export interface MatchParams {
  url: string;
  hint: string | null;
  db: Database;
  config: any;
  groups: any[];
  topN: number;
  noPrescore: boolean;
  verbose: boolean;
  log: (msg: string) => void;
  apiKey: string;
}

export interface MatchResult {
  classification: any;
  matches: any[];
  candidateCount: number;
  candidatesSent: number;
  candidateIds: number[];
  prescoreCutoff: number;
  model: string;
  rawResponse: string;
}

export interface MatchStrategy {
  name: string;
  match(params: MatchParams): Promise<MatchResult>;
}

// ─── Strategy Registry ──────────────────────────────────────────────────────

export const strategyRegistry = new Map<string, () => MatchStrategy>();

export function getStrategy(name: string): MatchStrategy {
  const factory = strategyRegistry.get(name);
  if (!factory) {
    const available = [...strategyRegistry.keys()].join(", ");
    throw new Error(
      `Unknown match strategy "${name}". Available: ${available || "(none registered)"}`
    );
  }
  return factory();
}
