/**
 * Binary plist parsing helpers using macOS `plutil`.
 *
 * Extracts timestamps from Safari's extra_attributes and local_attributes
 * binary plist blobs on the bookmarks table.
 */

/**
 * Convert a binary plist blob to XML string using plutil.
 */
async function blobToXml(blob: Buffer): Promise<string> {
  const proc = Bun.spawn(["plutil", "-convert", "xml1", "-o", "-", "--", "-"], {
    stdin: new Blob([blob]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const xml = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`plutil failed (exit ${exitCode}): ${stderr}`);
  }
  return xml;
}

/**
 * Extract a date value for a given key from plist XML.
 * Returns ISO 8601 string or null if key not found.
 *
 * Handles both flat keys (e.g., <key>DateLastViewed</key><date>...</date>)
 * and nested keys (e.g., com.apple.Bookmark → DateAdded).
 */
function extractDate(xml: string, key: string): string | null {
  // Match <key>KEY</key> followed by optional whitespace and <date>VALUE</date>
  const pattern = new RegExp(
    `<key>${escapeRegex(key)}</key>\\s*<date>([^<]+)</date>`
  );
  const match = xml.match(pattern);
  return match ? match[1] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const xml = await blobToXml(blob);
  return {
    dateLastViewed: extractDate(xml, "DateLastViewed"),
    dateAdded: extractDate(xml, "DateAdded"),
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
  const xml = await blobToXml(blob);
  return {
    lastVisitTime: extractDate(xml, "LastVisitTime"),
    dateClosed: extractDate(xml, "DateClosed"),
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

  // Return the most meaningful timestamp
  return local.lastVisitTime || extra.dateLastViewed || extra.dateAdded || null;
}

/**
 * Get the creation date from a group or tab's extra_attributes blob.
 */
export async function getDateAdded(
  extraBlob: Buffer | null
): Promise<string | null> {
  if (!extraBlob || extraBlob.length === 0) return null;
  const xml = await blobToXml(extraBlob);
  return extractDate(xml, "DateAdded");
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
