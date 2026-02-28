#!/usr/bin/env bun

/**
 * Reads cached Raindrop.io collections and raindrops, serializes them
 * using the Safari Tab Groups schema (profiles → tabGroups → tabs).
 *
 * Cache is populated by sync-tabgroups and stored at
 * ~/.cache/safari-tabgroups/raindrop-collections.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- CLI flags ---
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`raindrop-tabgroups — List Raindrop.io collections as tab groups

Usage: raindrop-tabgroups [options]

Options:
  --json       Output as JSON instead of plain text
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message

Reads from the local cache at ~/.cache/safari-tabgroups/.
Run sync-tabgroups --raindrop first to populate or refresh the cache.`);
  process.exit(0);
}

const verbose = args.has("--verbose") || args.has("--debug");
const jsonMode = args.has("--json");

function log(...msg: unknown[]) {
  if (verbose) console.error("[debug]", ...msg);
}

// --- Cache ---
const cacheDir =
  process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "safari-tabgroups")
    : join(homedir(), ".cache", "safari-tabgroups");
const cacheFile = join(cacheDir, "raindrop-collections.json");
log("Cache file:", cacheFile);

// --- Types for the cache structure ---
interface RaindropCache {
  fetchedAt: string;
  collections: any[];
  raindrops: any[];
}

// --- Transform cached data into tab groups output ---

function toTabGroups(cache: RaindropCache) {
  const collections = cache.collections;
  const raindrops = cache.raindrops;

  // Build parent title lookup for flattening nested collections
  const titleById = new Map<number, string>();
  for (const c of collections) titleById.set(c._id, c.title);

  function fullTitle(col: any): string {
    if (col.parent?.$id) {
      const parentTitle = titleById.get(col.parent.$id);
      if (parentTitle) return `${parentTitle} / ${col.title}`;
    }
    return col.title;
  }

  // Group raindrops by collection ID
  const raindropsByCollection = new Map<number, any[]>();
  for (const r of raindrops) {
    const colId = r.collection?.$id;
    if (colId == null) continue;
    let list = raindropsByCollection.get(colId);
    if (!list) {
      list = [];
      raindropsByCollection.set(colId, list);
    }
    list.push(r);
  }

  // Build tab groups from collections
  const tabGroups: { name: string; tabs: { title: string; url: string }[] }[] = [];

  for (const col of collections) {
    const colRaindrops = raindropsByCollection.get(col._id) || [];
    if (colRaindrops.length === 0) continue;

    const tabs = colRaindrops
      .filter((r: any) => r.link)
      .map((r: any) => ({ title: r.title || "(untitled)", url: r.link }));

    if (tabs.length > 0) {
      tabGroups.push({ name: fullTitle(col), tabs });
    }
  }

  return {
    profiles: [
      {
        name: "Raindrop.io",
        tabGroups,
      },
    ],
  };
}

// --- Main ---

if (!existsSync(cacheFile)) {
  console.error("No cached data. Run sync-tabgroups first.");
  process.exit(1);
}

const cache: RaindropCache = JSON.parse(readFileSync(cacheFile, "utf-8"));
log(`Loaded cache from ${cache.fetchedAt}`);

// Transform and output
const output = toTabGroups(cache);
if (jsonMode) {
  console.log(JSON.stringify(output, null, 2));
} else {
  for (const profile of output.profiles) {
    for (const group of profile.tabGroups) {
      for (const tab of group.tabs) {
        console.log(`${profile.name} / ${group.name} / ${tab.title} (${tab.url})`);
      }
    }
  }
}
