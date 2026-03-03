import { fetchAndConvertToMarkdown } from "scrape2md";
import { cardSearchText, parseCollectionCard, type CollectionCardMatch } from "../cards/types";
import { softmaxEntropy } from "../retrieval/local-embedding";
import {
  extractCardPageSignals,
  scoreCollectionCardCandidates,
} from "./card-match";
import type { MatchParams, MatchResult, MatchStrategy } from "./types";
import { strategyRegistry } from "./types";

function recencyBoost(lastActive: string): number {
  const daysAgo =
    (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo <= 7) return 0.15;
  if (daysAgo <= 30) return 0.1;
  if (daysAgo <= 90) return 0.05;
  return 0;
}

export class LlmFetchStrategy implements MatchStrategy {
  name = "llm-fetch";

  async match(params: MatchParams): Promise<MatchResult> {
    const { url, hint, db, config, groups, noPrescore, verbose, log, apiKey } = params;

    log(`Fetching page content: ${url}`);
    let markdown: string;
    try {
      markdown = await fetchAndConvertToMarkdown(url, fetch);
    } catch (err) {
      throw new Error(`Failed to fetch URL: ${err}`);
    }

    const signals = extractCardPageSignals(url, markdown, config.match.max_page_bytes);
    const truncated = markdown.slice(0, config.match.max_page_bytes);
    let candidates: { group: any; localScore: number }[];
    const candidateCount = groups.length;

    if (noPrescore) {
      log("Pre-scoring disabled (--no-prescore), using arbitrary group order");
      candidates = groups
        .slice(0, config.match.max_groups_in_prompt)
        .map((group) => ({ group, localScore: 0 }));
    } else {
      const domainGroupIds = new Set(
        (
          db.prepare(`SELECT DISTINCT group_id FROM items WHERE url LIKE '%' || ? || '%'`).all(
            signals.hostname
          ) as { group_id: number }[]
        ).map((row) => row.group_id)
      );

      const scored = scoreCollectionCardCandidates(groups, signals, domainGroupIds);

      if (hint) {
        const hintLower = hint.toLowerCase();
        let hintMatches = 0;
        for (const candidate of scored) {
          const searchable = cardSearchText(candidate.group);
          if (searchable.includes(hintLower)) {
            candidate.localScore = Math.min(1, candidate.localScore + 0.35);
            candidate.breakdown.total = candidate.localScore;
            hintMatches++;
          }
        }
        log(`Hint "${hint}" boosted ${hintMatches} group(s)`);
      }

      scored.sort((a, b) => b.localScore - a.localScore);
      candidates = scored
        .slice(0, config.match.max_groups_in_prompt)
        .map((candidate) => ({ group: candidate.group, localScore: candidate.localScore }));

      if (verbose) {
        log(`Pre-scored ${groups.length} groups, sending top ${candidates.length} to LLM:`);
        for (const candidate of candidates.slice(0, 10)) {
          log(`  ${candidate.localScore.toFixed(3)}  [${candidate.group.source}] ${candidate.group.name}`);
        }
      }
    }

    const candidateLines = candidates
      .map((candidate, index) => {
        const card = parseCollectionCard(candidate.group);
        return (
          `${index + 1}. [${candidate.group.source}] "${candidate.group.name}" — ` +
          `keyphrases: ${JSON.stringify(card.keyphrases)} | ` +
          `includes: ${JSON.stringify(card.includes.slice(0, 3))} | ` +
          `excludes: ${JSON.stringify(card.excludes.slice(0, 2))} | ` +
          `pre-score: ${candidate.localScore.toFixed(2)} | ` +
          `${card.definition || "no definition"}`
        );
      })
      .join("\n");

    const hintSection = hint
      ? `\n\n## User Hint\nThe user suggests this page relates to: "${hint}". Weight matching Collection Cards more heavily.\n`
      : "";

    const userMessage = `## Web Page URL
${url}
${hintSection}
## Web Page Content
${truncated}

## Candidate Collection Cards
${candidateLines}`;

    log(`Sending ${candidates.length} candidates to LLM (model: ${config.openrouter.model})...`);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        ...(config.openrouter.max_tokens ? { max_tokens: config.openrouter.max_tokens } : {}),
        messages: [
          { role: "system", content: config.match.system_prompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${body}`);
    }

    const llmData = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const raw = llmData.choices[0].message.content.trim();
    let result: { matches?: CollectionCardMatch[] };

    try {
      let jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      try {
        result = JSON.parse(jsonStr);
      } catch {
        const lastBrace = jsonStr.lastIndexOf("}");
        if (lastBrace <= 0) throw new Error("No valid JSON found");
        jsonStr = jsonStr.slice(0, lastBrace + 1);
        const openBrackets =
          (jsonStr.match(/\[/g) || []).length - (jsonStr.match(/\]/g) || []).length;
        const openBraces =
          (jsonStr.match(/\{/g) || []).length - (jsonStr.match(/\}/g) || []).length;
        jsonStr += "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
        log("LLM response appeared truncated, attempted repair");
        result = JSON.parse(jsonStr);
      }
    } catch {
      throw new Error(`Failed to parse LLM response: ${raw}`);
    }

    const matches = (result.matches || []).map((match) => {
      const group = groups.find(
        (candidate: any) => candidate.name === match.group && candidate.source === match.source
      );
      const boost = group?.last_active ? recencyBoost(group.last_active) : 0;
      return {
        ...match,
        rawScore: match.score,
        score: Math.min(1, match.score + boost),
        lastActive: group?.last_active || null,
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
      candidateCount,
      candidatesSent: candidates.length,
      candidateIds: candidates.map((candidate) => candidate.group.id),
      prescoreCutoff: candidates[candidates.length - 1]?.localScore ?? 0,
      model: config.openrouter.model,
      rawResponse: raw,
      pageSignalExcerpt: signals.excerpt || null,
      pageKeyphrases: [...signals.keywords].sort(),
      top1Margin,
      topKEntropy,
      isAmbiguous,
    };
  }
}

strategyRegistry.set("llm-fetch", () => new LlmFetchStrategy());
