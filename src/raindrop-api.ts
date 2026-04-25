/**
 * Raindrop.io API helpers — shared between raindrop-add CLI and the server.
 */

import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { resolveConfigPath } from "./config.ts";

const RAINDROP_BASE = "https://api.raindrop.io/rest/v1";

export function loadRaindropApiKey(): string {
  const configPath = resolveConfigPath();
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

export async function findCollection(
  apiKey: string,
  name: string,
): Promise<{ _id: number; title: string; parent?: { $id: number } } | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const [rootRes, childRes] = await Promise.all([
    fetch(`${RAINDROP_BASE}/collections`, { headers }),
    fetch(`${RAINDROP_BASE}/collections/childrens`, { headers }),
  ]);

  if (!rootRes.ok) throw new Error(`API ${rootRes.status}: ${await rootRes.text()}`);
  if (!childRes.ok) throw new Error(`API ${childRes.status}: ${await childRes.text()}`);

  const rootData = (await rootRes.json()) as { items: any[] };
  const childData = (await childRes.json()) as { items: any[] };
  const all = [...rootData.items, ...childData.items];

  const nameLower = name.toLowerCase();

  // Exact match first
  const exact = all.find((c) => c.title.toLowerCase() === nameLower);
  if (exact) return exact;

  // If name contains " / ", match the last segment
  const segments = name.split(" / ");
  const leafName = segments[segments.length - 1].toLowerCase();
  const leafMatch = all.find((c) => c.title.toLowerCase() === leafName);
  if (leafMatch) return leafMatch;

  // Substring match
  const substr = all.find((c) => c.title.toLowerCase().includes(nameLower));
  if (substr) return substr;

  return null;
}

export async function addToCollection(
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
