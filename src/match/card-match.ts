import { fetchAndConvertToMarkdown } from "scrape2md";
import {
  cardSearchText,
  parseCollectionCard,
  type CardScoreBreakdown,
  type CollectionCardMatch,
} from "../cards/types";
import {
  dotProduct,
  embedTextWithConfig,
  parseVector,
  softmaxEntropy,
} from "../retrieval/local-embedding";
import type { MatchParams, MatchResult, MatchStrategy } from "./types";
import { strategyRegistry } from "./types";

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "is","it","as","be","was","are","been","from","has","had","have","not","this",
  "that","which","their","they","we","you","your","can","will","all","more",
  "about","up","out","so","what","its","into","than","them","then","these",
  "our","new","also","just","most","how","where","when","who","may","each",
]);

export interface CardPageSignals {
  hostname: string;
  pathSegments: string[];
  title: string;
  headings: string[];
  excerpt: string;
  text: string;
  keywords: Set<string>;
}

export interface ScoredCollectionCard {
  group: any;
  localScore: number;
  breakdown: CardScoreBreakdown;
}

function extractContentLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const contentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("![")) continue;
    if (trimmed.startsWith("[![")) continue;
    if (!trimmed.startsWith("#") && trimmed.length < 40) continue;
    const linked = (trimmed.match(/\[.*?\]\(.*?\)/g) || []).join("");
    if (!trimmed.startsWith("#") && trimmed.length > 0 && linked.length / trimmed.length > 0.7) {
      continue;
    }
    contentLines.push(trimmed);
  }
  return contentLines;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(
    (token) => !STOP_WORDS.has(token)
  );
}

export function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 4) return false;
  if (shorter.length / longer.length < 0.75) return false;
  return longer.startsWith(shorter);
}

function addKeywords(target: Set<string>, tokens: string[]): void {
  for (const token of tokens) {
    target.add(token);
    if (token.includes("-")) {
      for (const part of token.split("-")) {
        if (part.length > 2 && !STOP_WORDS.has(part)) {
          target.add(part);
        }
      }
    }
  }
}

export function extractCardPageSignals(
  url: string,
  markdown: string,
  maxExcerptBytes: number
): CardPageSignals {
  let hostname = "";
  let pathSegments: string[] = [];
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.replace(/^www\./, "");
    pathSegments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 1)
      .map((segment) => segment.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  } catch {}

  const contentLines = extractContentLines(markdown);
  const headingLines = contentLines
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);

  const title = headingLines[0] || "";
  const headings = headingLines.slice(0, 2);
  const bodyLines = contentLines.filter((line) => !line.startsWith("#"));
  const excerpt = bodyLines.join("\n").slice(0, maxExcerptBytes);
  const text = [title, ...headings, excerpt].filter(Boolean).join(" ").toLowerCase();

  const keywords = new Set<string>();
  addKeywords(keywords, tokenize(text));
  addKeywords(
    keywords,
    hostname
      .split(".")
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 2 && !["com", "org", "net", "io"].includes(part))
  );
  addKeywords(keywords, pathSegments.filter((segment) => segment.length > 2));

  return { hostname, pathSegments, title, headings, excerpt, text, keywords };
}

function phraseMatches(phrase: string, signals: CardPageSignals): boolean {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) return false;
  if (signals.text.includes(normalized)) return true;

  const parts = tokenize(normalized);
  if (parts.length === 0) return false;
  return parts.every(
    (part) =>
      signals.keywords.has(part) ||
      [...signals.keywords].some((keyword) => isNearMatch(part, keyword))
  );
}

function tokenOverlapScore(text: string, signals: CardPageSignals): number {
  const uniqueTokens = new Set(tokenize(text));
  if (uniqueTokens.size === 0) return 0;
  let matched = 0;
  for (const token of uniqueTokens) {
    if (
      signals.keywords.has(token) ||
      [...signals.keywords].some((keyword) => isNearMatch(token, keyword))
    ) {
      matched++;
    }
  }
  return matched / uniqueTokens.size;
}

function phraseArrayScore(phrases: string[], signals: CardPageSignals): number {
  if (phrases.length === 0) return 0;
  let matched = 0;
  for (const phrase of phrases) {
    if (phraseMatches(phrase, signals)) matched++;
  }
  return matched / phrases.length;
}

export function scoreCollectionCardCandidates(
  groups: any[],
  signals: CardPageSignals,
  domainGroupIds: Set<number>
): ScoredCollectionCard[] {
  return groups.map((group) => {
    const card = parseCollectionCard(group);
    const definition = tokenOverlapScore(card.definition, signals);
    const keyphrases = phraseArrayScore(card.keyphrases, signals);
    const includes = phraseArrayScore(card.includes, signals);
    const excludes = phraseArrayScore(card.excludes, signals);
    const domain = domainGroupIds.has(group.id) ? 1 : 0;
    const total = Math.max(
      0,
      Math.min(
        1,
        definition * 0.35 +
          keyphrases * 0.3 +
          includes * 0.2 +
          domain * 0.15 -
          excludes * 0.25
      )
    );

    return {
      group,
      localScore: total,
      breakdown: { definition, keyphrases, includes, excludes, domain, total },
    };
  });
}

function recencyBoost(lastActive: string): number {
  const daysAgo =
    (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo <= 7) return 0.15;
  if (daysAgo <= 30) return 0.1;
  if (daysAgo <= 90) return 0.05;
  return 0;
}

function buildReason(breakdown: CardScoreBreakdown): string {
  const positives = [
    { label: "definition overlap", value: breakdown.definition },
    { label: "keyphrase match", value: breakdown.keyphrases },
    { label: "include rule hit", value: breakdown.includes },
    { label: "domain prior", value: breakdown.domain },
  ]
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((entry) => entry.label);

  const pieces = positives.length > 0 ? positives : ["weak semantic overlap"];
  if (breakdown.excludes > 0) {
    pieces.push("exclude penalty applied");
  }
  return pieces.join("; ");
}

function parseExemplarVectors(raw: string | null | undefined): number[][] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        Array.isArray(entry) && entry.every((value) => typeof value === "number")
          ? (entry as number[])
          : null
      )
      .filter((entry): entry is number[] => Array.isArray(entry));
  } catch {
    return [];
  }
}

export class CardMatchStrategy implements MatchStrategy {
  name = "card-match";

  async match(params: MatchParams): Promise<MatchResult> {
    const { url, hint, db, config, groups, noPrescore, verbose, log } = params;

    log(`Fetching page content: ${url}`);
    let markdown: string;
    try {
      markdown = await fetchAndConvertToMarkdown(url, fetch);
    } catch (err) {
      throw new Error(`Failed to fetch URL: ${err}`);
    }

    const signals = extractCardPageSignals(url, markdown, config.match.max_page_bytes);
    if (hint) {
      const hintTerms = tokenize(hint);
      addKeywords(signals.keywords, hintTerms);
    }

    if (verbose) {
      log(
        `Extracted page signals: hostname=${signals.hostname}, title="${signals.title}", ${signals.keywords.size} keywords`
      );
    }

    const domainGroupIds = new Set(
      (
        db.prepare(`SELECT DISTINCT group_id FROM items WHERE url LIKE '%' || ? || '%'`).all(
          signals.hostname
        ) as { group_id: number }[]
      ).map((row) => row.group_id)
    );

    if (noPrescore) {
      log("card-match ignores --no-prescore because the strategy is fully local.");
    }
    const candidates = scoreCollectionCardCandidates(groups, signals, domainGroupIds);
    const queryEmbedding = await embedTextWithConfig(
      [signals.title, ...signals.headings, signals.excerpt].filter(Boolean).join(" "),
      config.enrich
    );

    if (hint) {
      const hintLower = hint.toLowerCase();
      for (const candidate of candidates) {
        const searchable = cardSearchText(candidate.group);
        if (searchable.includes(hintLower)) {
          candidate.localScore = Math.min(1, candidate.localScore + 0.35);
          candidate.breakdown.total = candidate.localScore;
        }
      }
    }

    let vectorBackedCount = 0;
    for (const candidate of candidates) {
      const centroid = parseVector(candidate.group.centroid_vector);
      const exemplars = parseExemplarVectors(candidate.group.exemplar_vectors);
      const matchesModel =
        candidate.group.representation_model_version === config.enrich.embedding_model_version;
      const canUseVectors =
        matchesModel &&
        centroid &&
        centroid.length === queryEmbedding.length &&
        exemplars.length > 0;

      if (!canUseVectors) continue;

      const sCentroid = Math.max(0, dotProduct(queryEmbedding, centroid));
      const sExemplar = Math.max(
        0,
        ...exemplars.map((vector) =>
          vector.length === queryEmbedding.length ? dotProduct(queryEmbedding, vector) : 0
        )
      );
      candidate.localScore = Math.max(0, Math.min(1, 0.6 * sExemplar + 0.4 * sCentroid));
      candidate.breakdown.total = candidate.localScore;
      vectorBackedCount++;
    }

    candidates.sort((a, b) => b.localScore - a.localScore);

    if (verbose) {
      for (const candidate of candidates.slice(0, 10)) {
        const b = candidate.breakdown;
        log(
          `  ${candidate.localScore.toFixed(3)} [${candidate.group.source}] ${candidate.group.name} ` +
            `(def=${b.definition.toFixed(2)} key=${b.keyphrases.toFixed(2)} inc=${b.includes.toFixed(2)} exc=${b.excludes.toFixed(2)} dom=${b.domain.toFixed(2)})`
        );
      }
    }

    const matches: CollectionCardMatch[] = candidates.map((candidate) => {
      const boost = candidate.group.last_active ? recencyBoost(candidate.group.last_active) : 0;
      const hasVectorReason =
        candidate.group.representation_model_version === config.enrich.embedding_model_version &&
        !!candidate.group.centroid_vector &&
        !!candidate.group.exemplar_vectors;
      return {
        group: candidate.group.name,
        source: candidate.group.source,
        rawScore: candidate.localScore,
        score: Math.min(1, candidate.localScore + boost),
        reason: hasVectorReason
          ? "vector exemplar alignment; vector centroid alignment"
          : buildReason(candidate.breakdown),
        lastActive: candidate.group.last_active || null,
      };
    });

    matches.sort((a, b) => b.score - a.score);
    const ambiguityScores = matches
      .slice(0, Math.max(2, config.match.ambiguity_top_k))
      .map((match) => match.score);
    const top1Margin =
      matches.length >= 2 ? Math.max(0, matches[0].score - matches[1].score) : 1;
    const topKEntropy = softmaxEntropy(ambiguityScores);
    const isAmbiguous =
      top1Margin < config.match.ambiguity_margin_threshold ||
      topKEntropy > config.match.ambiguity_entropy_threshold;

    return {
      classification: null,
      matches,
      candidateCount: groups.length,
      candidatesSent: candidates.length,
      candidateIds: candidates.map((candidate) => candidate.group.id),
      prescoreCutoff: candidates[candidates.length - 1]?.localScore ?? 0,
      model:
        vectorBackedCount > 0
          ? `card-match/${config.enrich.embedding_model_version}`
          : "card-match/lexical-v1",
      rawResponse: "",
      pageSignalExcerpt: signals.excerpt || null,
      pageKeyphrases: [...signals.keywords].sort(),
      top1Margin,
      topKEntropy,
      isAmbiguous,
    };
  }
}

strategyRegistry.set("card-match", () => new CardMatchStrategy());
