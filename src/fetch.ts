#!/usr/bin/env bun

import { fetchAndConvertToMarkdown } from "scrape2md";
import { parse } from "smol-toml";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- CLI arg parsing ---
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`fetch-tabgroup — Fetch a URL as markdown, optionally analyze it with an LLM

Usage: fetch <url> [options]

Options:
  --prompt <text>   Send the fetched markdown to OpenRouter with this prompt
  --verbose         Print debug info to stderr
  --debug           Like --verbose, plus save fetched markdown to a file
  --help, -h        Show this help message

Without --prompt, outputs the page content as markdown.
With --prompt, sends the content to OpenRouter (configured in fetch.config.toml) and outputs the LLM response.

Requires OPENROUTER_API_KEY environment variable when using --prompt.`);
  process.exit(0);
}

const positional: string[] = [];
let verbose = false;
let debug = false;
let prompt: string | undefined;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--verbose") {
    verbose = true;
  } else if (arg === "--debug") {
    debug = true;
    verbose = true;
  } else if (arg === "--prompt") {
    prompt = argv[++i];
    if (!prompt) {
      console.error("--prompt requires a value");
      process.exit(1);
    }
  } else if (arg.startsWith("-")) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(1);
  } else {
    positional.push(arg);
  }
}

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

if (positional.length < 1) {
  console.error("Usage: fetch <url> [--prompt <text>] [--verbose] [--debug]");
  process.exit(1);
}

const url = positional[0];
log("URL:", url);

// --- Fetch markdown ---
let markdown: string;
try {
  markdown = await fetchAndConvertToMarkdown(url, fetch);
} catch (err) {
  console.error(`Failed to fetch and convert URL: ${err}`);
  process.exit(1);
}

// --- Without --prompt: just output markdown ---
if (!prompt) {
  console.log(markdown);
  process.exit(0);
}

// --- With --prompt: send to OpenRouter ---

// Save debug markdown if requested
if (debug) {
  const filename = `debug-${Date.now()}.md`;
  writeFileSync(filename, markdown);
  log(`Saved markdown to ${filename}`);
}

// Load config
interface OpenRouterConfig {
  api_key: string;
  model: string;
  system_prompt: string;
  max_content_bytes: number;
  max_tokens?: number;
}

const configPath = join(import.meta.dir, "..", "fetch.config.toml");
log("Config path:", configPath);

let config: OpenRouterConfig;
try {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as { openrouter: OpenRouterConfig };
  config = parsed.openrouter;
} catch (err) {
  console.error(`Failed to load config from ${configPath}: ${err}`);
  process.exit(1);
}

// Resolve env var for api_key
let apiKey = config.api_key;
if (apiKey.startsWith("$")) {
  apiKey = process.env[apiKey.slice(1)] || "";
}
if (!apiKey) {
  console.error("OpenRouter API key is not set. Configure api_key in fetch.config.toml or set the environment variable.");
  process.exit(1);
}

// Truncate markdown
const truncated = markdown.slice(0, config.max_content_bytes);
log(`Markdown: ${markdown.length} bytes, truncated to ${truncated.length} bytes`);

// Call OpenRouter
const userMessage = `${prompt}\n\n${truncated}`;

log("Model:", config.model);
log("System prompt:", config.system_prompt);

const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: config.model,
    ...(config.max_tokens ? { max_tokens: config.max_tokens } : {}),
    messages: [
      { role: "system", content: config.system_prompt },
      { role: "user", content: userMessage },
    ],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`OpenRouter API error (${response.status}): ${body}`);
  process.exit(1);
}

const data = await response.json() as {
  choices: { message: { content: string } }[];
};

console.log(data.choices[0].message.content);
