import { fetchAndConvertToMarkdown } from "scrape2md";
import type { MatchStrategy, MatchParams, MatchResult } from "./types";
import { strategyRegistry } from "./types";

// ─── Pre-scoring helpers ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "is","it","as","be","was","are","been","from","has","had","have","not","this",
  "that","which","their","they","we","you","your","can","will","all","more",
  "about","up","out","so","what","its","into","than","them","then","these",
  "our","new","also","just","most","how","where","when","who","may","each",
]);

export interface PageSignals {
  hostname: string;
  pathSegments: string[];
  title: string;
  keywords: Set<string>;
}

interface ScoredGroup {
  group: any;
  localScore: number;
  topicScore: number;
  nameDescScore: number;
  categoryScore: number;
  domainScore: number;
}

/**
 * Extract "content" lines from markdown, filtering out navigation, images,
 * and short link-only lines that pollute keyword extraction.
 */
function extractContentLines(markdown: string): string {
  const lines = markdown.split("\n");
  const contentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      contentLines.push(trimmed);
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith("![")) continue;
    if (trimmed.startsWith("[![")) continue;
    if (trimmed.length < 40) continue;
    const linkFraction = (trimmed.match(/\[.*?\]\(.*?\)/g) || []).join("").length / trimmed.length;
    if (linkFraction > 0.7) continue;
    contentLines.push(trimmed);
  }
  return contentLines.join("\n");
}

export function extractPageSignals(url: string, markdown: string): PageSignals {
  let hostname = "";
  let pathSegments: string[] = [];
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.replace(/^www\./, "");
    pathSegments = parsed.pathname
      .split("/")
      .filter(s => s.length > 1)
      .map(s => s.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  } catch {}

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const contentText = extractContentLines(markdown);
  const text = (title + " " + contentText).toLowerCase();
  const words = text.match(/[a-z][a-z0-9-]{2,}/g) || [];
  const keywords = new Set<string>();
  for (const w of words) {
    if (!STOP_WORDS.has(w)) {
      keywords.add(w);
      if (w.includes("-")) {
        for (const part of w.split("-")) {
          if (part.length > 2 && !STOP_WORDS.has(part)) keywords.add(part);
        }
      }
    }
  }
  for (const part of hostname.split(".")) {
    if (part.length > 2 && part !== "com" && part !== "org" && part !== "net" && part !== "io") {
      keywords.add(part.toLowerCase());
    }
  }
  for (const seg of pathSegments) {
    if (seg.length > 2) keywords.add(seg);
  }

  return { hostname, pathSegments, title, keywords };
}

/**
 * Common morphological suffixes to strip when comparing words.
 */
const MORPHO_SUFFIXES = [
  "ization", "isation", "ment", "tion", "sion", "ing", "ness",
  "ity", "ous", "ive", "able", "ible", "ful", "less", "ed", "er", "ly", "es", "s",
];

/**
 * Strip common suffixes to get a rough word stem.
 * Returns the longest stem that is at least 4 characters.
 */
function roughStem(word: string): string {
  for (const suffix of MORPHO_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Check if two words are a "near match" — handles plurals and suffixes.
 */
function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 4) return false;
  // Direct prefix match with relaxed ratio
  if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.6) return true;
  // Stem-based match: "sandbox" and "sandboxing" both stem to "sandbox"
  return roughStem(shorter) === roughStem(longer);
}

/**
 * Build an inverse document frequency map for all topic parts across all groups.
 */
function buildTopicIdf(groups: any[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const g of groups) {
    const topics: string[] = g.topics ? JSON.parse(g.topics) : [];
    const seen = new Set<string>();
    for (const topic of topics) {
      for (const part of topic.toLowerCase().split("-").filter((p: string) => p.length > 2)) {
        if (!seen.has(part)) {
          seen.add(part);
          docFreq.set(part, (docFreq.get(part) || 0) + 1);
        }
      }
    }
  }
  const N = groups.length;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.min(1.0, Math.max(0.1, Math.log(N / df) / Math.log(N))));
  }
  return idf;
}

export function scoreGroupCandidates(
  groups: any[],
  signals: PageSignals,
  domainGroupIds: Set<number>
): ScoredGroup[] {
  const W_TOPIC = 0.5;
  const W_NAME_DESC = 0.3;
  const W_DOMAIN = 0.2;

  const topicIdf = buildTopicIdf(groups);
  const keywordArray = [...signals.keywords];

  return groups.map((g) => {
    let topicScore = 0;
    const topics: string[] = g.topics ? JSON.parse(g.topics) : [];
    if (topics.length > 0) {
      let weightedMatched = 0;
      let totalWeight = 0;
      for (const topic of topics) {
        const topicParts = topic.toLowerCase().split("-").filter((p: string) => p.length > 2);
        const topicWeight = topicParts.reduce((max, part) => Math.max(max, topicIdf.get(part) || 0.5), 0);
        totalWeight += topicWeight;
        const topicMatches = topicParts.some((part: string) =>
          signals.keywords.has(part) ||
          keywordArray.some(kw => isNearMatch(part, kw))
        );
        if (topicMatches) weightedMatched += topicWeight;
      }
      topicScore = totalWeight > 0 ? weightedMatched / totalWeight : 0;
    }

    const nameDescText = ((g.name || "") + " " + (g.description || "")).toLowerCase();
    const nameDescTokens = (nameDescText.match(/[a-z][a-z0-9-]{2,}/g) || [])
      .filter((w: string) => !STOP_WORDS.has(w));
    let nameDescScore = 0;
    if (nameDescTokens.length > 0) {
      const uniqueTokens = new Set(nameDescTokens);
      let matched = 0;
      for (const token of uniqueTokens) {
        if (signals.keywords.has(token)) matched++;
        else {
          const parts = token.split("-").filter((p: string) => p.length > 2);
          if (parts.some((p: string) => signals.keywords.has(p) || keywordArray.some(kw => isNearMatch(p, kw)))) matched++;
        }
      }
      nameDescScore = Math.min(1.0, matched / uniqueTokens.size);
    }

    const categoryScore = 0;
    const domainScore = domainGroupIds.has(g.id) ? 1.0 : 0.0;

    const localScore =
      topicScore * W_TOPIC +
      nameDescScore * W_NAME_DESC +
      domainScore * W_DOMAIN;

    return { group: g, localScore, topicScore, nameDescScore, categoryScore, domainScore };
  });
}

export function recencyBoost(lastActive: string): number {
  const daysAgo =
    (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo <= 7) return 0.15;
  if (daysAgo <= 30) return 0.1;
  if (daysAgo <= 90) return 0.05;
  return 0;
}

// ─── Shared helpers for match strategies ────────────────────────────────────

export interface PreparedMatch {
  candidates: { group: any; localScore: number }[];
  candidateCount: number;
  userMessage: string;
  systemPrompt: string;
}

export async function fetchPageContent(
  params: MatchParams,
): Promise<string> {
  const { url, skipFetch, config, log } = params;
  if (skipFetch) {
    log(`Skipping page fetch (--skip-fetch), using URL-only signals`);
    return "";
  }
  log(`Fetching page content: ${url}`);
  let markdown: string;
  try {
    markdown = await fetchAndConvertToMarkdown(url, fetch);
  } catch (err) {
    throw new Error(`Failed to fetch URL: ${err}`);
  }
  log(`Fetched ${markdown.length} bytes of page content`);
  const truncated = markdown.slice(0, config.match.max_page_bytes);
  log(`Truncated to ${truncated.length} bytes (max_page_bytes: ${config.match.max_page_bytes})`);
  return truncated;
}

export function prescore(
  params: MatchParams,
  truncated: string,
): { candidates: { group: any; localScore: number }[]; candidateCount: number } {
  const { url, hint, db, config, groups, noPrescore, verbose, log } = params;
  const candidateCount = groups.length;
  let candidates: { group: any; localScore: number }[];

  log("Pre-scoring candidates locally to select top groups for LLM...");
  if (noPrescore) {
    log("Pre-scoring disabled (--no-prescore), using arbitrary group order");
    candidates = groups
      .slice(0, config.match.max_groups_in_prompt)
      .map(g => ({ group: g, localScore: 0 }));
  } else {
    const pageSignals = extractPageSignals(url, truncated);

    if (hint) {
      const hintTerms = hint.toLowerCase().split(/[\s,]+/).filter((t: string) => t.length > 2);
      for (const term of hintTerms) {
        pageSignals.keywords.add(term);
      }
      log(`Hint injected ${hintTerms.length} term(s) into page signals: ${hintTerms.join(", ")}`);
    }

    log(`Extracted page signals: hostname=${pageSignals.hostname}, title="${pageSignals.title}", ${pageSignals.keywords.size} keywords`);

    const domainGroupIds = new Set(
      (db.prepare(`SELECT DISTINCT group_id FROM items WHERE url LIKE '%' || ? || '%'`)
        .all(pageSignals.hostname) as { group_id: number }[]).map(r => r.group_id)
    );
    log(`Domain match: ${domainGroupIds.size} group(s) contain URLs from ${pageSignals.hostname}`);

    log("Scoring groups using weights: topic=0.5, name/desc=0.3, domain=0.2");
    const scored = scoreGroupCandidates(groups, pageSignals, domainGroupIds);

    if (hint) {
      const hintLower = hint.toLowerCase();
      let hintMatches = 0;
      for (const s of scored) {
        const g = s.group;
        const searchable = [g.name, g.description, g.topics, g.category]
          .filter(Boolean).join(" ").toLowerCase();
        if (searchable.includes(hintLower)) {
          s.localScore = Math.min(1.0, s.localScore + 0.5);
          hintMatches++;
          if (verbose) log(`  Hint boost +0.50 for "${g.name}" [${g.source}]`);
        }
      }
      log(`Hint "${hint}" boosted ${hintMatches} group(s)`);
    }

    scored.sort((a, b) => b.localScore - a.localScore);
    candidates = scored.slice(0, config.match.max_groups_in_prompt);

    if (verbose) {
      log(`Pre-scored ${groups.length} groups, sending top ${candidates.length} to LLM:`);
      for (const c of candidates.slice(0, 10)) {
        const s = c as ScoredGroup;
        log(`  ${s.localScore.toFixed(3)}  [${s.group.source}] ${s.group.name}  (topic=${s.topicScore.toFixed(2)} name=${s.nameDescScore.toFixed(2)} cat=${s.categoryScore.toFixed(2)} domain=${s.domainScore.toFixed(2)})`);
      }
      if (candidates.length > 10) log(`  ... and ${candidates.length - 10} more`);
    }
  }

  return { candidates, candidateCount };
}

export function buildPrompt(
  params: MatchParams,
  truncated: string,
  candidates: { group: any; localScore: number }[],
): { systemPrompt: string; userMessage: string } {
  const { url, hint, skipFetch, config } = params;

  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. [${c.group.source}] "${c.group.name}" — ${c.group.category} | topics: ${c.group.topics || "[]"} | pre-score: ${c.localScore.toFixed(2)} | ${c.group.description || "no description"}`
    )
    .join("\n");
  const prescoreNote = `\nNote: pre-score is a rough keyword heuristic. A low pre-score does NOT mean the group is a poor match — use your own semantic judgment.\n`;

  const hintSection = hint ? `\n\n## User Hint\nThe user suggests this page relates to: "${hint}". Weight groups matching this hint more heavily.\n` : "";

  const contentSection = skipFetch
    ? `\n## Web Page Content\n(Not fetched — classify based on the URL alone)\n`
    : `\n## Web Page Content\n${truncated}\n`;

  const userMessage = `## Web Page URL
${url}
${hintSection}${contentSection}
## Candidate Groups
${prescoreNote}
${candidateLines}`;

  return { systemPrompt: config.match.system_prompt, userMessage };
}

export function parseMatchResponse(
  raw: string,
  groups: any[],
  verbose: boolean,
  log: (msg: string) => void,
): { classification: any; matches: any[] } {
  let result: {
    classification?: any;
    matches?: { group: string; source: string; score: number; reason: string }[];
  };

  try {
    let jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    try {
      result = JSON.parse(jsonStr);
    } catch {
      const lastBrace = jsonStr.lastIndexOf("}");
      if (lastBrace > 0) {
        jsonStr = jsonStr.slice(0, lastBrace + 1);
        const openBrackets = (jsonStr.match(/\[/g) || []).length - (jsonStr.match(/\]/g) || []).length;
        const openBraces = (jsonStr.match(/\{/g) || []).length - (jsonStr.match(/\}/g) || []).length;
        jsonStr += "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
        log("LLM response appeared truncated, attempted repair");
        result = JSON.parse(jsonStr);
      } else {
        throw new Error("No valid JSON found");
      }
    }
  } catch (e) {
    throw new Error(`Failed to parse LLM response: ${raw}`);
  }

  log("LLM returned classification, applying recency weighting to matches...");
  const matches = (result.matches || []).map((m) => {
    const group = groups.find(
      (g: any) => g.name === m.group && g.source === m.source
    );
    const boost = group?.last_active ? recencyBoost(group.last_active) : 0;
    if (verbose && boost > 0) {
      log(`  Recency boost +${boost.toFixed(2)} for "${m.group}" (active: ${group?.last_active})`);
    }
    return {
      ...m,
      rawScore: m.score,
      score: Math.min(1.0, m.score + boost),
      lastActive: group?.last_active || null,
    };
  });

  matches.sort((a, b) => b.score - a.score);

  return { classification: result.classification, matches };
}

// ─── LLM Fetch Strategy ─────────────────────────────────────────────────────

export class LlmFetchStrategy implements MatchStrategy {
  name = "llm-fetch";

  async match(params: MatchParams): Promise<MatchResult> {
    const { config, groups, log, apiKey } = params;

    const truncated = await fetchPageContent(params);
    const { candidates, candidateCount } = prescore(params, truncated);
    const { systemPrompt, userMessage } = buildPrompt(params, truncated, candidates);

    log(`Sending ${candidates.length} candidates to LLM (model: ${config.openrouter.model})...`);

    const llmMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.openrouter.model,
          ...(config.openrouter.max_tokens
            ? { max_tokens: config.openrouter.max_tokens }
            : {}),
          messages: llmMessages,
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${body}`);
    }

    const llmData = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const raw = llmData.choices[0].message.content.trim();
    const { classification, matches } = parseMatchResponse(raw, groups, params.verbose, log);

    const prescoreCutoff = candidates.length > 0 ? candidates[candidates.length - 1].localScore : 0;
    const llmInput = config.match.log_llm_io ? JSON.stringify(llmMessages) : undefined;

    return {
      classification,
      matches,
      candidateCount,
      candidatesSent: candidates.length,
      candidateIds: candidates.map(c => c.group.id),
      prescoreCutoff,
      model: config.openrouter.model,
      rawResponse: raw,
      llmInput,
    };
  }
}

// Register the strategy at module load
strategyRegistry.set("llm-fetch", () => new LlmFetchStrategy());
