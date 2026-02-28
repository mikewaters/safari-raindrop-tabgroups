#!/usr/bin/env bun

import { join } from "node:path";

// --- CLI arg parsing ---
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`list-tabgroups — List all tab group names from Safari and Raindrop.io

Usage: list-tabgroups [options]

Options:
  --json       Output merged JSON (profiles array)
  --safari     Only include Safari tab groups
  --raindrop   Only include Raindrop.io collections
  --verbose    Print debug info to stderr
  --debug      Like --verbose, plus extra logging
  --help, -h   Show this help message

Without --safari or --raindrop, both sources are included.
Gracefully skips sources whose cache is unavailable.`);
  process.exit(0);
}

let verbose = false;
let debug = false;
let jsonMode = false;
let wantSafari = false;
let wantRaindrop = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--verbose") verbose = true;
  else if (arg === "--debug") { debug = true; verbose = true; }
  else if (arg === "--json") jsonMode = true;
  else if (arg === "--safari") wantSafari = true;
  else if (arg === "--raindrop") wantRaindrop = true;
  else if (arg.startsWith("-")) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(1);
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

// --- Types ---
interface Tab { title: string; url: string; }
interface TabGroup { name: string; tabs: Tab[]; }
interface Profile { name: string; tabGroups: TabGroup[]; }

// --- Spawn sources in parallel ---
const allProfiles: Profile[] = [];
let sourcesFailed = 0;
const sourcesRequested = (wantSafari ? 1 : 0) + (wantRaindrop ? 1 : 0);

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

// --- Output ---
if (jsonMode) {
  console.log(JSON.stringify({ profiles: allProfiles }, null, 2));
} else {
  for (const profile of allProfiles) {
    console.log(profile.name);
    for (const group of profile.tabGroups) {
      console.log(`  ${group.name} (${group.tabs.length} tabs)`);
    }
    console.log();
  }
}
