import {
  List,
  ActionPanel,
  Action,
  Detail,
  Icon,
  Color,
  showToast,
  Toast,
  getPreferenceValues,
  LaunchProps,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef, useState } from "react";
import { execSync } from "child_process";
import { statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

interface Preferences {
  openrouterApiKey: string;
  binaryPath: string;
  verboseLogging: boolean;
  noCache: boolean;
  langfuseSecretKey?: string;
  langfusePublicKey?: string;
  langfuseBaseUrl?: string;
}

interface MatchClassification {
  category: string;
  topics: string[];
  description: string;
}

interface Match {
  score: number;
  source: string;
  group: string;
  reason: string;
  lastActive?: string;
  collectionCategory?: string;
  collectionTopics?: string[];
  collectionDescription?: string;
  userProject?: string | null;
  userDescription?: string | null;
}

interface MatchResponse {
  classification: MatchClassification;
  matches: Match[];
}

function getFrontmostBrowserUrl(): string {
  // Try Safari first, then Chrome, then Arc, then other browsers
  const browsers = [
    {
      name: "Safari",
      script: `tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Safari" then
  tell application "Safari" to return URL of current tab of front window
else
  error "not Safari"
end if`,
    },
    {
      name: "Google Chrome",
      script: `tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Google Chrome" then
  tell application "Google Chrome" to return URL of active tab of front window
else
  error "not Chrome"
end if`,
    },
    {
      name: "Arc",
      script: `tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Arc" then
  tell application "Arc" to return URL of active tab of front window
else
  error "not Arc"
end if`,
    },
  ];

  // First, check what the frontmost app is
  let frontApp: string;
  try {
    frontApp = execSync(
      `osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true'`,
      {
        timeout: 5000,
      },
    )
      .toString()
      .trim();
  } catch {
    throw new Error("Could not determine the frontmost application");
  }

  // Try the matching browser
  for (const browser of browsers) {
    try {
      const url = execSync(`osascript -e '${browser.script.replace(/'/g, "'\\''")}'`, {
        timeout: 5000,
      })
        .toString()
        .trim();
      if (url && url.startsWith("http")) {
        return url;
      }
    } catch {
      // Not this browser, try next
    }
  }

  // Generic fallback: try to get URL from the frontmost app
  try {
    const url = execSync(
      `osascript -e 'tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
tell application frontApp
  return URL of current tab of front window
end tell'`,
      { timeout: 5000 },
    )
      .toString()
      .trim();
    if (url && url.startsWith("http")) {
      return url;
    }
  } catch {
    // ignore
  }

  throw new Error(`The frontmost application "${frontApp}" is not a supported browser, or no URL could be retrieved.`);
}

interface RunMatchOpts {
  hint?: string;
  verbose?: boolean;
  noCache?: boolean;
  langfuse?: { secretKey: string; publicKey: string; baseUrl: string };
}

function runMatch(binaryPath: string, url: string, apiKey: string, opts: RunMatchOpts): MatchResponse {
  const args = ["match", "--json", `"${url}"`];
  if (opts.hint) args.push(`"${opts.hint}"`);
  if (opts.verbose) args.push("--verbose", "--filelog");
  if (opts.noCache) args.push("--no-cache");
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`,
    OPENROUTER_API_KEY: apiKey,
  } as Record<string, string>;
  if (opts.langfuse) {
    env.LANGFUSE_SECRET_KEY = opts.langfuse.secretKey;
    env.LANGFUSE_PUBLIC_KEY = opts.langfuse.publicKey;
    env.LANGFUSE_BASE_URL = opts.langfuse.baseUrl;
  }
  const stdout = execSync(`"${binaryPath}" ${args.join(" ")}`, {
    timeout: 60000,
    env,
  })
    .toString()
    .trim();

  // The binary may emit warnings or log lines before the JSON object.
  // Extract the first valid JSON object from stdout.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`bookmark-index returned no JSON. Output: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

async function addToRaindrop(binaryPath: string, pageUrl: string, collectionName: string): Promise<string> {
  const raindropAddPath = join(dirname(binaryPath), "raindrop-add");
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`,
  } as Record<string, string>;

  const stdout = execSync(`"${raindropAddPath}" "${pageUrl}" "${collectionName}" --json`, { timeout: 30000, env })
    .toString()
    .trim();

  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`raindrop-add returned no JSON. Output: ${stdout.slice(0, 200)}`);
  }
  const result = JSON.parse(stdout.slice(jsonStart));
  if (!result.ok) {
    throw new Error(result.error || "Unknown error");
  }
  return result.raindrop?.title || collectionName;
}

interface CollectionRow {
  id: number;
  source: string;
  name: string;
  category: string | null;
  tab_count: number;
  last_active: string | null;
}

function listCollections(binaryPath: string): CollectionRow[] {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`,
  } as Record<string, string>;

  const stdout = execSync(`"${binaryPath}" list --json`, {
    timeout: 10000,
    env,
  })
    .toString()
    .trim();

  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return [];
  const result = JSON.parse(stdout.slice(jsonStart));
  return result.rows || [];
}

function SearchCollections({ binaryPath, pageUrl }: { binaryPath: string; pageUrl: string }) {
  const [searchText, setSearchText] = useState("");
  const { data, isLoading } = usePromise(async () => listCollections(binaryPath));

  const collections = data || [];
  const filtered = searchText
    ? collections.filter((c) => c.name.toLowerCase().includes(searchText.toLowerCase()))
    : collections;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search collections..."
      onSearchTextChange={setSearchText}
      throttle
    >
      {filtered.map((col) => {
        const lastActive = col.last_active ? new Date(col.last_active).toLocaleDateString() : "unknown";
        return (
          <List.Item
            key={`${col.source}-${col.id}`}
            title={col.name}
            subtitle={col.category || undefined}
            icon={{
              source: Icon.Bookmark,
              tintColor: col.source === "safari" ? Color.Blue : Color.Purple,
            }}
            accessories={[
              { tag: { value: col.source, color: col.source === "safari" ? Color.Blue : Color.Purple } },
              { text: `${col.tab_count} urls` },
              { text: lastActive },
            ]}
            actions={
              <ActionPanel>
                {col.source === "raindrop" && (
                  <Action
                    title="Add to Raindrop"
                    icon={Icon.Plus}
                    onAction={async () => {
                      const toast = await showToast({
                        style: Toast.Style.Animated,
                        title: "Adding to Raindrop...",
                        message: col.name,
                      });
                      try {
                        const title = await addToRaindrop(binaryPath, pageUrl, col.name);
                        toast.style = Toast.Style.Success;
                        toast.title = "Added to Raindrop";
                        toast.message = `"${title}" → ${col.name}`;
                      } catch (err) {
                        toast.style = Toast.Style.Failure;
                        toast.title = "Failed to add";
                        toast.message = err instanceof Error ? err.message : String(err);
                      }
                    }}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy Collection Name"
                  content={col.name}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function MatchDetail({ match, classification }: { match: Match; classification: MatchClassification }) {
  const lastActive = match.lastActive ? new Date(match.lastActive).toLocaleDateString() : "Unknown";

  const markdown = `# ${match.group}

**Score:** ${match.score.toFixed(2)}
**Source:** ${match.source}
**Last Active:** ${lastActive}

---

## Match Reason

${match.reason}

---

## Page Classification

**Category:** ${classification.category}
**Topics:** ${(classification.topics || []).join(", ")}

${classification.description || ""}`;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={match.group}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label
            title="Score"
            text={match.score.toFixed(2)}
            icon={{
              source: Icon.Star,
              tintColor: match.score >= 0.7 ? Color.Green : match.score >= 0.4 ? Color.Yellow : Color.SecondaryText,
            }}
          />
          <Detail.Metadata.Label title="Source" text={match.source} />
          <Detail.Metadata.Label title="Last Active" text={lastActive} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Page Category" text={classification.category} />
          <Detail.Metadata.TagList title="Page Topics">
            {(classification.topics || []).map((topic) => (
              <Detail.Metadata.TagList.Item key={topic} text={topic} color={Color.Blue} />
            ))}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Collection Name" content={match.group} />
          <Action.CopyToClipboard
            title="Copy Match Reason"
            content={match.reason}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

function getLastSyncDate(): string | null {
  const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const cacheDir = join(xdgCache, "safari-tabgroups");
  const files = ["SafariTabs.db", "raindrop-collections.json"];
  let latest: Date | null = null;
  for (const file of files) {
    try {
      const mtime = statSync(join(cacheDir, file)).mtime;
      if (!latest || mtime > latest) latest = mtime;
    } catch {
      // file may not exist
    }
  }
  return latest
    ? latest.toLocaleDateString() + " " + latest.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
}

function scoreColor(score: number): Color {
  if (score >= 0.7) return Color.Green;
  if (score >= 0.4) return Color.Yellow;
  return Color.SecondaryText;
}

export default function Command(props: LaunchProps<{ arguments: { hint: string } }>) {
  const {
    binaryPath,
    openrouterApiKey,
    verboseLogging,
    noCache,
    langfuseSecretKey,
    langfusePublicKey,
    langfuseBaseUrl,
  } = getPreferenceValues<Preferences>();
  const hint = props.arguments.hint?.trim() || undefined;
  const langfuse =
    langfuseSecretKey && langfusePublicKey && langfuseBaseUrl
      ? { secretKey: langfuseSecretKey, publicKey: langfusePublicKey, baseUrl: langfuseBaseUrl }
      : undefined;

  // Guard against React strict mode double-invocation (avoids duplicate LLM calls)
  const cachedResult = useRef<{ url: string; result: MatchResponse } | null>(null);

  const { data, isLoading, error } = usePromise(async () => {
    if (cachedResult.current) return cachedResult.current;

    const url = getFrontmostBrowserUrl();
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Matching URL...",
      message: hint ? `${url} (hint: ${hint})` : url,
    });

    try {
      const result = runMatch(binaryPath, url, openrouterApiKey, { hint, verbose: verboseLogging, noCache, langfuse });
      toast.hide();
      cachedResult.current = { url, result };
      return { url, result };
    } catch (err) {
      toast.hide();
      throw err;
    }
  });

  if (error) {
    return (
      <List>
        <List.EmptyView
          title="Error"
          description={error.message}
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
        />
      </List>
    );
  }

  const classification = data?.result?.classification;
  const matches = data?.result?.matches || [];
  const url = data?.url || "";
  const lastSync = getLastSyncDate();

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={matches.length > 0}
      navigationTitle="Bookmark Index"
      searchBarPlaceholder="Filter matches..."
    >
      {url && (
        <List.Section
          title={`Matches for ${url}`}
          subtitle={
            [
              classification ? `${classification.category} [${(classification.topics || []).join(", ")}]` : null,
              lastSync ? `synced ${lastSync}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
        >
          {matches.map((match, index) => {
            const lastActive = match.lastActive ? new Date(match.lastActive).toLocaleDateString() : "unknown";
            const parts = match.group.split(" / ");
            const collectionName = parts[parts.length - 1];
            const parentPath = parts.length > 1 ? parts.slice(0, -1).join(" / ") : null;
            return (
              <List.Item
                key={`${match.source}-${match.group}-${index}`}
                title={collectionName}
                icon={{
                  source: Icon.Bookmark,
                  tintColor: scoreColor(match.score),
                }}
                accessories={[
                  ...(match.userProject ? [{ tag: { value: match.userProject, color: Color.Green } }] : []),
                  { tag: { value: match.source, color: match.source === "safari" ? Color.Blue : Color.Purple } },
                  { text: match.score.toFixed(2) },
                ]}
                detail={
                  <List.Item.Detail
                    markdown={[
                      `**${match.group}**`,
                      `Score: ${match.score.toFixed(2)}  ·  Source: ${match.source}  ·  Active: ${lastActive}`,
                      match.collectionCategory
                        ? `Collection: ${match.collectionCategory} [${(match.collectionTopics || []).join(", ")}]`
                        : null,
                      match.userProject ? `**Project:** ${match.userProject}` : null,
                      match.userDescription ? `**Notes:** ${match.userDescription}` : null,
                      `\n${match.reason}`,
                      `\n---\n`,
                      classification
                        ? `**Page:** ${classification.category} [${(classification.topics || []).join(", ")}]`
                        : null,
                      classification?.description ? classification.description : null,
                      lastSync ? `\n*Synced: ${lastSync}*` : null,
                    ]
                      .filter((l) => l !== null)
                      .join("\n\n")}
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="View Details"
                      icon={Icon.Eye}
                      target={<MatchDetail match={match} classification={classification!} />}
                    />
                    {match.source === "raindrop" && (
                      <Action
                        title="Add to Raindrop"
                        icon={Icon.Plus}
                        shortcut={{ modifiers: ["cmd"], key: "return" }}
                        onAction={async () => {
                          const toast = await showToast({
                            style: Toast.Style.Animated,
                            title: "Adding to Raindrop...",
                            message: match.group,
                          });
                          try {
                            const title = await addToRaindrop(binaryPath, url, match.group);
                            toast.style = Toast.Style.Success;
                            toast.title = "Added to Raindrop";
                            toast.message = `"${title}" → ${match.group}`;
                          } catch (err) {
                            toast.style = Toast.Style.Failure;
                            toast.title = "Failed to add";
                            toast.message = err instanceof Error ? err.message : String(err);
                          }
                        }}
                      />
                    )}
                    <Action.CopyToClipboard
                      title="Copy Collection Name"
                      content={match.group}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                    <Action.CopyToClipboard
                      title="Copy URL"
                      content={url}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
          <List.Item
            key="search-collections"
            title="Search All Collections…"
            icon={{ source: Icon.MagnifyingGlass, tintColor: Color.SecondaryText }}
            detail={<List.Item.Detail markdown="Browse and search all bookmark collections by name." />}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Search Collections"
                  icon={Icon.MagnifyingGlass}
                  target={<SearchCollections binaryPath={binaryPath} pageUrl={url} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {!isLoading && matches.length === 0 && !error && !classification && (
        <List.Section title="No Matches Found">
          <List.Item
            key="search-collections-empty"
            title="Search All Collections…"
            subtitle="Browse collections by name"
            icon={{ source: Icon.MagnifyingGlass, tintColor: Color.SecondaryText }}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Search Collections"
                  icon={Icon.MagnifyingGlass}
                  target={<SearchCollections binaryPath={binaryPath} pageUrl={url} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {!isLoading && matches.length === 0 && !error && classification && (
        <List.Section
          title="No Matches Found"
          subtitle={`${classification.category} [${(classification.topics || []).join(", ")}]`}
        >
          <List.Item
            title="Copy Classification"
            subtitle={`${classification.category} — ${(classification.topics || []).join(", ")}`}
            icon={{ source: Icon.Clipboard, tintColor: Color.SecondaryText }}
            detail={
              <List.Item.Detail
                markdown={[
                  `# No Matches Found`,
                  `**Category:** ${classification.category}`,
                  `**Topics:** ${(classification.topics || []).join(", ")}`,
                  classification.description ? `\n${classification.description}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n")}
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="Copy Classification"
                  content={`${classification.category} [${(classification.topics || []).join(", ")}]`}
                />
                <Action.CopyToClipboard
                  title="Copy Classification with Description"
                  content={`${classification.category} [${(classification.topics || []).join(", ")}]\n${classification.description || ""}`}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
                {url && (
                  <Action.CopyToClipboard
                    title="Copy URL"
                    content={url}
                    shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
                  />
                )}
              </ActionPanel>
            }
          />
          <List.Item
            key="search-collections-no-match"
            title="Search All Collections…"
            icon={{ source: Icon.MagnifyingGlass, tintColor: Color.SecondaryText }}
            detail={<List.Item.Detail markdown="Browse and search all bookmark collections by name." />}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Search Collections"
                  icon={Icon.MagnifyingGlass}
                  target={<SearchCollections binaryPath={binaryPath} pageUrl={url} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}
