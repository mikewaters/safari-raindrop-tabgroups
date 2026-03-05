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
import { execSync } from "child_process";

interface Preferences {
  openrouterApiKey: string;
  binaryPath: string;
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

function runMatch(binaryPath: string, url: string, apiKey: string, hint?: string): MatchResponse {
  const hintArg = hint ? ` "${hint}"` : "";
  const stdout = execSync(`"${binaryPath}" match --json "${url}"${hintArg}`, {
    timeout: 60000,
    env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`, OPENROUTER_API_KEY: apiKey },
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

function scoreColor(score: number): Color {
  if (score >= 0.7) return Color.Green;
  if (score >= 0.4) return Color.Yellow;
  return Color.SecondaryText;
}

export default function Command(props: LaunchProps<{ arguments: { hint: string } }>) {
  const { binaryPath, openrouterApiKey } = getPreferenceValues<Preferences>();
  const hint = props.arguments.hint?.trim() || undefined;

  const { data, isLoading, error } = usePromise(async () => {
    const url = getFrontmostBrowserUrl();
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Matching URL...",
      message: hint ? `${url} (hint: ${hint})` : url,
    });

    try {
      const result = runMatch(binaryPath, url, openrouterApiKey, hint);
      toast.hide();
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
            classification ? `${classification.category} [${(classification.topics || []).join(", ")}]` : undefined
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
                  { tag: { value: match.source, color: match.source === "safari" ? Color.Blue : Color.Purple } },
                  { text: match.score.toFixed(2) },
                ]}
                detail={
                  <List.Item.Detail
                    markdown={`## ${collectionName}\n\n${match.reason}`}
                    metadata={
                      <List.Item.Detail.Metadata>
                        {parentPath && (
                          <List.Item.Detail.Metadata.Label title="Parent" text={parentPath} icon={Icon.Folder} />
                        )}
                        <List.Item.Detail.Metadata.Label
                          title="Score"
                          text={match.score.toFixed(2)}
                          icon={{
                            source: Icon.Star,
                            tintColor: scoreColor(match.score),
                          }}
                        />
                        <List.Item.Detail.Metadata.Label title="Source" text={match.source} />
                        <List.Item.Detail.Metadata.Label title="Last Active" text={lastActive} />
                        {classification && (
                          <>
                            <List.Item.Detail.Metadata.Separator />
                            <List.Item.Detail.Metadata.Label title="Page Category" text={classification.category} />
                            <List.Item.Detail.Metadata.TagList title="Topics">
                              {(classification.topics || []).map((topic) => (
                                <List.Item.Detail.Metadata.TagList.Item key={topic} text={topic} color={Color.Blue} />
                              ))}
                            </List.Item.Detail.Metadata.TagList>
                          </>
                        )}
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="View Details"
                      icon={Icon.Eye}
                      target={<MatchDetail match={match} classification={classification!} />}
                    />
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
        </List.Section>
      )}

      {!isLoading && matches.length === 0 && !error && (
        <List.EmptyView
          title="No Matches Found"
          description="No bookmark collections matched the current URL"
          icon={Icon.MagnifyingGlass}
        />
      )}
    </List>
  );
}
