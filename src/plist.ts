/**
 * Binary plist parsing helpers.
 *
 * Extracts timestamps from Safari's extra_attributes and local_attributes
 * binary plist blobs on the bookmarks table.
 *
 * Uses bplist-parser for cross-platform support (works on Linux containers).
 */

import bplistParser from "bplist-parser";

/**
 * Parse a binary plist blob into a JS object.
 */
function parsePlist(blob: Buffer): Record<string, any> | null {
  if (!blob || blob.length === 0) return null;
  try {
    const parsed = bplistParser.parseBuffer(blob);
    return parsed && parsed.length > 0 ? parsed[0] : null;
  } catch {
    return null;
  }
}

/**
 * Extract a date value from a parsed plist object.
 * Searches top-level keys and nested dicts for the given key name.
 * Returns ISO 8601 string or null.
 */
function extractDate(obj: Record<string, any> | null, key: string): string | null {
  if (!obj) return null;

  // Check top-level
  if (obj[key] instanceof Date) {
    return obj[key].toISOString();
  }

  // Check nested dicts (e.g., Safari stores dates under "com.apple.Bookmark" dict)
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object" && !(val instanceof Date) && !Array.isArray(val)) {
      if (val[key] instanceof Date) {
        return val[key].toISOString();
      }
    }
  }

  return null;
}

/**
 * Timestamps available from extra_attributes plist on tab rows.
 */
export interface ExtraTimestamps {
  dateLastViewed: string | null;
  dateAdded: string | null;
}

/**
 * Timestamps available from local_attributes plist on tab rows.
 */
export interface LocalTimestamps {
  lastVisitTime: string | null;
  dateClosed: string | null;
}

/**
 * Parse extra_attributes blob and extract timestamps.
 */
export async function parseExtraAttributes(
  blob: Buffer | null
): Promise<ExtraTimestamps> {
  if (!blob || blob.length === 0) {
    return { dateLastViewed: null, dateAdded: null };
  }
  const obj = parsePlist(blob);
  return {
    dateLastViewed: extractDate(obj, "DateLastViewed"),
    dateAdded: extractDate(obj, "DateAdded"),
  };
}

/**
 * Parse local_attributes blob and extract timestamps.
 */
export async function parseLocalAttributes(
  blob: Buffer | null
): Promise<LocalTimestamps> {
  if (!blob || blob.length === 0) {
    return { lastVisitTime: null, dateClosed: null };
  }
  const obj = parsePlist(blob);
  return {
    lastVisitTime: extractDate(obj, "LastVisitTime"),
    dateClosed: extractDate(obj, "DateClosed"),
  };
}

/**
 * Get the best "last active" timestamp from a tab's plist blobs.
 * Prefers LastVisitTime > DateLastViewed > DateAdded.
 */
export async function getTabLastActive(
  extraBlob: Buffer | null,
  localBlob: Buffer | null
): Promise<string | null> {
  const [extra, local] = await Promise.all([
    parseExtraAttributes(extraBlob),
    parseLocalAttributes(localBlob),
  ]);

  return local.lastVisitTime || extra.dateLastViewed || extra.dateAdded || null;
}

/**
 * Get the creation date from a group or tab's extra_attributes blob.
 */
export async function getDateAdded(
  extraBlob: Buffer | null
): Promise<string | null> {
  if (!extraBlob || extraBlob.length === 0) return null;
  const obj = parsePlist(extraBlob);
  return extractDate(obj, "DateAdded");
}

/**
 * Process multiple blobs in parallel batches.
 * Returns results in the same order as input.
 */
export async function batchProcess<T>(
  items: Buffer[],
  processor: (blob: Buffer) => Promise<T>,
  batchSize = 20
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}
