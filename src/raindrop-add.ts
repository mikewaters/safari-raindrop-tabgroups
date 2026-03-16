#!/usr/bin/env bun

/**
 * Adds a URL to a Raindrop.io collection.
 *
 * Usage: raindrop-add <url> <collection-name> [--title "..."] [--json] [--verbose]
 */

import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { resolveConfigPath } from "./config.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

if (flags.has("--help") || flags.has("-h")) {
  console.log(`raindrop-add — Add a URL to a Raindrop.io collection

Usage: raindrop-add <url> <collection-name> [options]

Options:
  --title "..."  Set the bookmark title (default: auto-detected by Raindrop)
  --json         Output result as JSON
  --verbose      Print debug info to stderr
  --help, -h     Show this help message

The collection is looked up by name (case-insensitive substring match).
The Raindrop API key is read from your config file.`);
  process.exit(0);
}

const verbose = flags.has("--verbose");
const jsonMode = flags.has("--json");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

// Parse --title flag
let title: string | undefined;
const titleIdx = args.indexOf("--title");
if (titleIdx !== -1 && titleIdx + 1 < args.length) {
  title = args[titleIdx + 1];
}

const url = positional[0];
const collectionName = positional[1];

if (!url || !collectionName) {
  console.error("Usage: raindrop-add <url> <collection-name>");
  process.exit(1);
}

// --- Config & API key ---

function loadApiKey(): string {
  const configPath = resolveConfigPath();
  log("config:", configPath);

  interface RaindropConfig {
    api_key: string;
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as { raindrop: RaindropConfig };
  let apiKey = parsed.raindrop.api_key;
  if (apiKey.startsWith("$")) {
    apiKey = process.env[apiKey.slice(1)] || "";
  }
  if (!apiKey) {
    throw new Error(
      "Raindrop API key not set. Configure api_key in config.toml or set the RAINDROP_TOKEN environment variable.",
    );
  }
  return apiKey;
}

// --- Raindrop API ---

const RAINDROP_BASE = "https://api.raindrop.io/rest/v1";

async function findCollection(
  apiKey: string,
  name: string,
): Promise<{ _id: number; title: string; parent?: { $id: number } } | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Fetch root + child collections
  const [rootRes, childRes] = await Promise.all([
    fetch(`${RAINDROP_BASE}/collections`, { headers }),
    fetch(`${RAINDROP_BASE}/collections/childrens`, { headers }),
  ]);

  if (!rootRes.ok) throw new Error(`API ${rootRes.status}: ${await rootRes.text()}`);
  if (!childRes.ok) throw new Error(`API ${childRes.status}: ${await childRes.text()}`);

  const rootData = (await rootRes.json()) as { items: any[] };
  const childData = (await childRes.json()) as { items: any[] };
  const all = [...rootData.items, ...childData.items];

  log(`Fetched ${all.length} collections`);

  const nameLower = name.toLowerCase();

  // Exact match first
  const exact = all.find((c) => c.title.toLowerCase() === nameLower);
  if (exact) return exact;

  // If name contains " / ", match the last segment (collection name without parent path)
  const segments = name.split(" / ");
  const leafName = segments[segments.length - 1].toLowerCase();
  const leafMatch = all.find((c) => c.title.toLowerCase() === leafName);
  if (leafMatch) return leafMatch;

  // Substring match
  const substr = all.find((c) => c.title.toLowerCase().includes(nameLower));
  if (substr) return substr;

  return null;
}

async function addToCollection(
  apiKey: string,
  collectionId: number,
  linkUrl: string,
  linkTitle?: string,
): Promise<any> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body: any = {
    link: linkUrl,
    collection: { $id: collectionId },
    pleaseParse: {},
  };
  if (linkTitle) {
    body.title = linkTitle;
  }

  log(`POST /raindrop to collection ${collectionId}`);
  const res = await fetch(`${RAINDROP_BASE}/raindrop`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Raindrop API ${res.status}: ${text}`);
  }

  return (await res.json()) as { item: any };
}

// --- Main ---

async function main() {
  const apiKey = loadApiKey();

  log(`Looking up collection: "${collectionName}"`);
  const collection = await findCollection(apiKey, collectionName);
  if (!collection) {
    console.error(`Collection not found: "${collectionName}"`);
    process.exit(1);
  }
  log(`Found collection: "${collection.title}" (id: ${collection._id})`);

  const result = await addToCollection(apiKey, collection._id, url, title);
  const item = result.item;

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          collection: { id: collection._id, title: collection.title },
          raindrop: {
            id: item._id,
            title: item.title,
            link: item.link,
            type: item.type,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Added to "${collection.title}": ${item.title || url}`);
  }
}

main().catch((err) => {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
});
