import {
  List,
  Form,
  ActionPanel,
  Action,
  Detail,
  Icon,
  Color,
  showToast,
  Toast,
  getPreferenceValues,
  popToRoot,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { execFile } from "child_process";
import { promisify } from "util";
import { syncSafari } from "./sync";

const execFileP = promisify(execFile);

interface Preferences {
  binaryPath: string;
}

interface ListRow {
  id: number;
  source: "safari" | "raindrop";
  name: string;
  profile: string | null;
  tab_count: number;
  last_active: string | null;
  category: string | null;
}

interface GroupRow {
  id: number;
  source: "safari" | "raindrop";
  name: string;
  profile: string | null;
  tab_count: number;
  last_active: string | null;
  user_description: string | null;
  user_project: string | null;
  user_updated_at: string | null;
  category: string | null;
  description: string | null;
}

const MAX_PROJECT = 255;

async function listSafariGroups(binaryPath: string): Promise<ListRow[]> {
  const { stdout } = await execFileP(binaryPath, ["list", "--safari", "--json"]);
  const parsed = JSON.parse(stdout) as { rows: ListRow[] };
  return parsed.rows ?? [];
}

async function loadGroup(binaryPath: string, name: string): Promise<GroupRow | { error: string }> {
  try {
    const { stdout } = await execFileP(binaryPath, ["show-group", "--source", "safari", "--name", name, "--json"]);
    const parsed = JSON.parse(stdout);
    if (parsed && parsed.error === "not_found") {
      return { error: `Tab group "${name}" not found.` };
    }
    return parsed as GroupRow;
  } catch (err) {
    const e = err as { stdout?: { toString?: () => string }; message?: string };
    const stdout = e?.stdout?.toString?.() || "";
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.error === "not_found") return { error: `Tab group "${name}" not found.` };
      } catch {
        // fall through
      }
    }
    return { error: `Failed to load group: ${e?.message ?? String(err)}` };
  }
}

async function saveGroup(binaryPath: string, name: string, project: string, description: string): Promise<void> {
  const args = ["update-group", "--source", "safari", "--name", name];
  if (project.length === 0) args.push("--clear-project");
  else args.push("--project", project);
  if (description.length === 0) args.push("--clear-description");
  else args.push("--description", description);
  args.push("--json");
  await execFileP(binaryPath, args);
}

function EditGroupForm({ group: initial }: { group: GroupRow }) {
  const { binaryPath } = getPreferenceValues<Preferences>();
  const [project, setProject] = useState(initial.user_project ?? "");
  const [description, setDescription] = useState(initial.user_description ?? "");

  return (
    <Form
      navigationTitle={initial.name}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            icon={Icon.SaveDocument}
            onSubmit={async (values: { project: string; description: string }) => {
              if (values.project.length > MAX_PROJECT) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Project too long",
                  message: `Max ${MAX_PROJECT} chars (got ${values.project.length})`,
                });
                return;
              }
              if (values.project.includes("\n")) {
                await showToast({ style: Toast.Style.Failure, title: "Project must be a single line" });
                return;
              }
              const toast = await showToast({ style: Toast.Style.Animated, title: "Saving..." });
              try {
                await saveGroup(binaryPath, initial.name, values.project, values.description);
                toast.style = Toast.Style.Success;
                toast.title = "Saved";
                await popToRoot();
              } catch (err) {
                toast.style = Toast.Style.Failure;
                toast.title = "Save failed";
                toast.message = err instanceof Error ? err.message : String(err);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Tab Group"
        text={`${initial.name}  ·  ${initial.tab_count} tabs${
          initial.last_active ? `  ·  last active ${new Date(initial.last_active).toLocaleDateString()}` : ""
        }`}
      />
      {initial.category ? <Form.Description title="LLM Category" text={initial.category} /> : null}
      <Form.TextField
        id="project"
        title="Project"
        placeholder="e.g. q2-launch"
        value={project}
        onChange={setProject}
        info={`Single line, max ${MAX_PROJECT} characters. Preserved across syncs.`}
      />
      <Form.TextArea
        id="description"
        title="Notes"
        placeholder="Free-form notes about this tab group"
        value={description}
        onChange={setDescription}
        info="Preserved across syncs; never overwritten by the LLM classifier."
      />
      {initial.user_updated_at ? (
        <Form.Description title="Last edited" text={new Date(initial.user_updated_at).toLocaleString()} />
      ) : null}
    </Form>
  );
}

function GroupListItem({ row, onReload }: { row: ListRow; onReload: () => Promise<void> }) {
  const { binaryPath } = getPreferenceValues<Preferences>();
  const { push } = useNavigation();

  const lastActive = row.last_active ? new Date(row.last_active).toLocaleDateString() : "unknown";

  return (
    <List.Item
      title={row.name}
      subtitle={row.profile ?? undefined}
      keywords={[row.profile ?? "", row.category ?? ""].filter(Boolean)}
      icon={{ source: Icon.Bookmark, tintColor: Color.Blue }}
      accessories={[
        ...(row.category ? [{ tag: { value: row.category, color: Color.SecondaryText } }] : []),
        { text: `${row.tab_count} tabs` },
        { text: lastActive },
      ]}
      actions={
        <ActionPanel>
          <Action
            title="Edit Project & Notes"
            icon={Icon.Pencil}
            onAction={async () => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Loading..." });
              const result = await loadGroup(binaryPath, row.name);
              if ("error" in result) {
                toast.style = Toast.Style.Failure;
                toast.title = result.error;
                return;
              }
              toast.hide();
              push(<EditGroupForm group={result} />);
            }}
          />
          <Action.CopyToClipboard title="Copy Tab Group Name" content={row.name} />
          <Action
            title="Sync Tab Groups"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={async () => {
              try {
                await syncSafari(binaryPath);
                await onReload();
              } catch {
                // toast already shown by syncSafari
              }
            }}
          />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const { binaryPath } = getPreferenceValues<Preferences>();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: ListRow[] }
  >({ kind: "loading" });

  const reload = async () => {
    setState({ kind: "loading" });
    try {
      const rows = await listSafariGroups(binaryPath);
      setState({ kind: "ready", rows });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    reload();
  }, [binaryPath]);

  if (state.kind === "error") {
    return <Detail markdown={`# Failed to load tab groups\n\n${state.message}`} />;
  }

  const syncAction = (
    <Action
      title="Sync Tab Groups"
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={async () => {
        try {
          await syncSafari(binaryPath);
          await reload();
        } catch {
          // toast already shown
        }
      }}
    />
  );

  return (
    <List isLoading={state.kind === "loading"} searchBarPlaceholder="Search Safari tab groups...">
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title="No matching tab groups"
        description="If your group is missing entirely, run Sync Tab Groups (⌘R) to refresh from Safari."
        actions={<ActionPanel>{syncAction}</ActionPanel>}
      />
      {state.kind === "ready" &&
        state.rows.map((row) => <GroupListItem key={`${row.source}-${row.id}`} row={row} onReload={reload} />)}
    </List>
  );
}
