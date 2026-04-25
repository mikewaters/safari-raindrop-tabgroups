#!/usr/bin/env bun

/**
 * Adds a URL to a Raindrop.io collection.
 *
 * Usage: raindrop-add <url> <collection-name> [--title "..."] [--json] [--verbose]
 */

import { loadRaindropApiKey, findCollection, addToCollection } from "./raindrop-api.ts";

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

// --- Main ---

async function main() {
  const apiKey = loadRaindropApiKey();

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
