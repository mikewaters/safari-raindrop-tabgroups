import { spawn } from "node:child_process";
import type { MatchStrategy, MatchParams, MatchResult } from "./types";
import { strategyRegistry } from "./types";
import {
  fetchPageContent,
  prescore,
  buildPrompt,
  parseMatchResponse,
} from "./llm-fetch";

// ─── Claude CLI Strategy ────────────────────────────────────────────────────

function claudePrompt(systemPrompt: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--output-format", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

export class ClaudeStrategy implements MatchStrategy {
  name = "claude";

  async match(params: MatchParams): Promise<MatchResult> {
    const { config, groups, log } = params;

    const truncated = await fetchPageContent(params);
    const { candidates, candidateCount } = prescore(params, truncated);
    const { systemPrompt, userMessage } = buildPrompt(params, truncated, candidates);

    log(`Sending ${candidates.length} candidates to claude CLI...`);

    const raw = await claudePrompt(systemPrompt, userMessage);
    const { classification, matches } = parseMatchResponse(raw, groups, params.verbose, log);

    const prescoreCutoff = candidates.length > 0 ? candidates[candidates.length - 1].localScore : 0;
    const llmInput = config.match.log_llm_io ? `${systemPrompt}\n\n${userMessage}` : undefined;

    return {
      classification,
      matches,
      candidateCount,
      candidatesSent: candidates.length,
      candidateIds: candidates.map(c => c.group.id),
      prescoreCutoff,
      model: "claude",
      rawResponse: raw,
      llmInput,
    };
  }
}

// Register the strategy at module load
strategyRegistry.set("claude", () => new ClaudeStrategy());
