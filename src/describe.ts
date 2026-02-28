#!/usr/bin/env bun

import { fetchAndConvertToMarkdown } from "scrape2md";
import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- CLI arg parsing ---
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`describe-tabgroup — Classify and describe Safari tab groups using an LLM

Usage: describe <group-name> [options]
       describe --all [options]

Options:
  --all        Process all tab groups (output is a keyed JSON object)
  --fetch      Fetch page content for up to N tabs per group for richer analysis
  --safari     Only include Safari tab groups
  --raindrop   Only include Raindrop.io collections
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message

Reads tab groups from safari-tabgroups and sends them to OpenRouter for classification.
Returns JSON with: description, category, topics, intent, and confidence score.

Categories and other settings are configured in fetch.config.toml.
Requires OPENROUTER_API_KEY environment variable.`);
  process.exit(0);
}

const positional: string[] = [];
let verbose = false;
let debug = false;
let all = false;
let fetchContent = false;
let wantSafari = false;
let wantRaindrop = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--verbose") verbose = true;
  else if (arg === "--debug") { debug = true; verbose = true; }
  else if (arg === "--all") all = true;
  else if (arg === "--fetch") fetchContent = true;
  else if (arg === "--safari") wantSafari = true;
  else if (arg === "--raindrop") wantRaindrop = true;
  else if (arg.startsWith("-")) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(1);
  } else {
    positional.push(arg);
  }
}

// Default to both sources if neither is specified
if (!wantSafari && !wantRaindrop) {
  wantSafari = true;
  wantRaindrop = true;
}

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

const groupName = positional[0];
if (!groupName && !all) {
  console.error('Usage: describe <group-name> [--fetch] [--verbose] [--debug]');
  console.error('       describe --all [--fetch] [--verbose] [--debug]');
  process.exit(1);
}

// --- Load config ---
interface DescribeConfig {
  max_tabs_to_fetch: number;
  skip_domains: string[];
  per_tab_max_bytes: number;
  categories: string[];
  system_prompt: string;
}

interface OpenRouterConfig {
  api_key: string;
  model: string;
  system_prompt: string;
  max_content_bytes: number;
  max_tokens?: number;
}

const configPath = join(import.meta.dir, "..", "fetch.config.toml");
log("Config path:", configPath);

let openrouterConfig: OpenRouterConfig;
let describeConfig: DescribeConfig;
try {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as { openrouter: OpenRouterConfig; describe: DescribeConfig };
  openrouterConfig = parsed.openrouter;
  describeConfig = parsed.describe;
} catch (err) {
  console.error(`Failed to load config from ${configPath}: ${err}`);
  process.exit(1);
}

// Resolve env var for api_key
let apiKey = openrouterConfig.api_key;
if (apiKey.startsWith("$")) {
  apiKey = process.env[apiKey.slice(1)] || "";
}
if (!apiKey) {
  console.error("OpenRouter API key is not set. Configure api_key in fetch.config.toml or set the environment variable.");
  process.exit(1);
}

// --- Get tab group data ---
interface Tab { title: string; url: string; }
interface TabGroup { name: string; tabs: Tab[]; }
interface Profile { name: string; tabGroups: TabGroup[]; }

const allProfiles: Profile[] = [];
let sourcesFailed = 0;
const sourcesRequested = (wantSafari ? 1 : 0) + (wantRaindrop ? 1 : 0);

// Spawn both sources in parallel
const safariPromise = wantSafari ? (async () => {
  log("Running safari-tabgroups --json --cached...");
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "safari.ts"), "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    log(`safari-tabgroups failed: ${stderr}`);
    sourcesFailed++;
    return;
  }
  const data = JSON.parse(stdout) as { profiles: Profile[] };
  allProfiles.push(...data.profiles);
})() : Promise.resolve();

const raindropPromise = wantRaindrop ? (async () => {
  log("Running raindrop-tabgroups...");
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "raindrop.ts"), "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    log(`raindrop-tabgroups failed: ${stderr}`);
    sourcesFailed++;
    return;
  }
  const data = JSON.parse(stdout) as { profiles: Profile[] };
  allProfiles.push(...data.profiles);
})() : Promise.resolve();

await Promise.all([safariPromise, raindropPromise]);

if (sourcesFailed === sourcesRequested) {
  console.error("No tab group data available — all sources failed.");
  process.exit(1);
}

// Collect all tab groups across profiles
const allGroups: TabGroup[] = [];
for (const profile of allProfiles) {
  for (const group of profile.tabGroups) {
    allGroups.push(group);
  }
}

// Filter to requested groups
let targetGroups: TabGroup[];
if (all) {
  targetGroups = allGroups;
} else {
  const found = allGroups.find(g => g.name === groupName);
  if (!found) {
    console.error(`Tab group "${groupName}" not found. Available groups:`);
    for (const g of allGroups) console.error(`  - ${g.name} (${g.tabs.length} tabs)`);
    process.exit(1);
  }
  targetGroups = [found];
}

// --- Process each group ---
const categoriesList = describeConfig.categories.map(c => `"${c}"`).join(", ");
const systemPrompt = (describeConfig.system_prompt.trim() || openrouterConfig.system_prompt)
  .replace("{{categories}}", categoriesList);
const results: Record<string, unknown> = {};

for (const group of targetGroups) {
  log(`\nProcessing: ${group.name} (${group.tabs.length} tabs)`);

  // Build tab listing
  const tabLines = group.tabs.map(t => `- ${t.title} (${t.url})`).join("\n");
  let userMessage = `Tab group: "${group.name}"\n\nTabs (${group.tabs.length} total):\n${tabLines}`;

  // Tier 2: fetch markdown for top N tabs
  if (fetchContent) {
    const skipDomains = new Set(describeConfig.skip_domains);
    const eligible = group.tabs.filter(t => {
      try {
        const host = new URL(t.url).hostname;
        return !skipDomains.has(host) && !host.endsWith(".ts.net");
      } catch { return false; }
    });

    const toFetch = eligible.slice(0, describeConfig.max_tabs_to_fetch);
    log(`Fetching content for ${toFetch.length} tabs (skipped ${group.tabs.length - eligible.length} by domain filter)`);

    const contentSections: string[] = [];
    for (const tab of toFetch) {
      try {
        log(`  Fetching: ${tab.url}`);
        const md = await fetchAndConvertToMarkdown(tab.url, fetch);
        const truncated = md.slice(0, describeConfig.per_tab_max_bytes);
        contentSections.push(`## ${tab.title}\n${truncated}`);
      } catch (err) {
        log(`  Failed to fetch ${tab.url}: ${err}`);
      }
    }

    if (contentSections.length > 0) {
      userMessage += `\n\nPage content for selected tabs:\n\n${contentSections.join("\n\n")}`;
    }
  }

  log("\n--- Assembled prompt ---");
  log(userMessage);
  log("--- End prompt ---\n");

  // Call OpenRouter
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openrouterConfig.model,
      ...(openrouterConfig.max_tokens ? { max_tokens: openrouterConfig.max_tokens } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`OpenRouter API error for "${group.name}" (${response.status}): ${body}`);
    continue;
  }

  const llmData = await response.json() as {
    choices: { message: { content: string } }[];
  };

  const raw = llmData.choices[0].message.content.trim();
  try {
    // Strip markdown fences if the model wraps them anyway
    const jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    results[group.name] = JSON.parse(jsonStr);
  } catch {
    log(`Warning: Could not parse JSON for "${group.name}", storing raw response`);
    results[group.name] = { _raw: raw };
  }
}

// Output
if (all) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(JSON.stringify(results[targetGroups[0].name], null, 2));
}
