# Complete Raycast Extension Code Examples

## Example 1: Simple Todo List

A complete todo list extension with add, complete, and delete functionality.

```typescript
import {
  List,
  ActionPanel,
  Action,
  Form,
  showToast,
  Toast,
  Icon,
  Color,
  confirmAlert,
  Alert,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { LocalStorage } from "@raycast/api";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
}

export default function Command() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load todos from storage
  useEffect(() => {
    async function loadTodos() {
      const stored = await LocalStorage.getItem<string>("todos");
      if (stored) {
        setTodos(JSON.parse(stored));
      }
      setIsLoading(false);
    }
    loadTodos();
  }, []);

  // Save todos to storage whenever they change
  useEffect(() => {
    if (!isLoading) {
      LocalStorage.setItem("todos", JSON.stringify(todos));
    }
  }, [todos, isLoading]);

  async function addTodo(title: string) {
    const newTodo: Todo = {
      id: Date.now().toString(),
      title,
      completed: false,
      createdAt: new Date(),
    };
    setTodos([...todos, newTodo]);
    await showToast(Toast.Style.Success, "Todo added");
  }

  async function toggleTodo(id: string) {
    setTodos(
      todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  }

  async function deleteTodo(id: string) {
    const confirmed = await confirmAlert({
      title: "Delete Todo",
      message: "Are you sure you want to delete this todo?",
      primaryAction: {
        title: "Delete",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (confirmed) {
      setTodos(todos.filter((todo) => todo.id !== id));
      await showToast(Toast.Style.Success, "Todo deleted");
    }
  }

  const activeTodos = todos.filter((todo) => !todo.completed);
  const completedTodos = todos.filter((todo) => todo.completed);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search todos...">
      <List.Section title="Active" subtitle={`${activeTodos.length} items`}>
        {activeTodos.map((todo) => (
          <List.Item
            key={todo.id}
            title={todo.title}
            icon={{ source: Icon.Circle, tintColor: Color.Blue }}
            accessories={[
              { date: todo.createdAt },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Mark Complete"
                  icon={Icon.Checkmark}
                  onAction={() => toggleTodo(todo.id)}
                />
                <Action
                  title="Delete"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => deleteTodo(todo.id)}
                  shortcut={{ modifiers: ["cmd"], key: "delete" }}
                />
                <ActionPanel.Section>
                  <Action.Push
                    title="Add Todo"
                    icon={Icon.Plus}
                    target={<CreateTodoForm onSubmit={addTodo} />}
                    shortcut={{ modifiers: ["cmd"], key: "n" }}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      {completedTodos.length > 0 && (
        <List.Section title="Completed" subtitle={`${completedTodos.length} items`}>
          {completedTodos.map((todo) => (
            <List.Item
              key={todo.id}
              title={todo.title}
              icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
              accessories={[
                { tag: { value: "Done", color: Color.Green } },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="Mark Active"
                    icon={Icon.Circle}
                    onAction={() => toggleTodo(todo.id)}
                  />
                  <Action
                    title="Delete"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() => deleteTodo(todo.id)}
                    shortcut={{ modifiers: ["cmd"], key: "delete" }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {todos.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Todos"
          description="Press ⌘ N to create your first todo"
          icon={Icon.Checkmark}
        />
      )}
    </List>
  );
}

function CreateTodoForm({ onSubmit }: { onSubmit: (title: string) => void }) {
  const { pop } = useNavigation();

  function handleSubmit(values: { title: string }) {
    onSubmit(values.title);
    pop();
  }

  return (
    <Form
      navigationTitle="Add Todo"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Todo" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" placeholder="Enter todo title" />
    </Form>
  );
}
```

## Example 2: GitHub Repository Search

Search GitHub repositories with API integration.

```typescript
import { List, ActionPanel, Action, Icon, Color } from "@raycast/api";
import { useState } from "react";
import { useFetch } from "@raycast/utils";

interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  language: string;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface SearchResponse {
  items: Repository[];
  total_count: number;
}

export default function Command() {
  const [searchText, setSearchText] = useState("");

  const { data, isLoading } = useFetch<SearchResponse>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(
      searchText
    )}&sort=stars&order=desc&per_page=20`,
    {
      execute: searchText.length > 0,
      keepPreviousData: true,
    }
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search GitHub repositories..."
      onSearchTextChange={setSearchText}
      throttle
    >
      {data?.items.map((repo) => (
        <List.Item
          key={repo.id}
          title={repo.name}
          subtitle={repo.owner.login}
          icon={{ source: repo.owner.avatar_url }}
          accessories={[
            { text: repo.language || "Unknown" },
            { icon: Icon.Star, text: repo.stargazers_count.toString() },
          ]}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={repo.html_url} />
              <Action.CopyToClipboard
                title="Copy URL"
                content={repo.html_url}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
              <Action.Push
                title="Show Details"
                icon={Icon.Eye}
                target={<RepositoryDetail repo={repo} />}
                shortcut={{ modifiers: ["cmd"], key: "d" }}
              />
            </ActionPanel>
          }
        />
      ))}

      {searchText.length === 0 && (
        <List.EmptyView
          title="Search GitHub"
          description="Enter a search query to find repositories"
          icon={Icon.MagnifyingGlass}
        />
      )}
    </List>
  );
}

function RepositoryDetail({ repo }: { repo: Repository }) {
  const markdown = `
# ${repo.full_name}

${repo.description || "*No description provided*"}

## Statistics
- ⭐ **Stars**: ${repo.stargazers_count.toLocaleString()}
- 💻 **Language**: ${repo.language || "Unknown"}
- 🔄 **Last Updated**: ${new Date(repo.updated_at).toLocaleDateString()}

[View on GitHub →](${repo.html_url})
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={repo.name}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Repository" text={repo.full_name} />
          <Detail.Metadata.Label title="Owner" text={repo.owner.login} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Stars"
            text={repo.stargazers_count.toLocaleString()}
            icon={{ source: Icon.Star, tintColor: Color.Yellow }}
          />
          <Detail.Metadata.Label title="Language" text={repo.language || "Unknown"} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Link
            title="GitHub"
            text="Open Repository"
            target={repo.html_url}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.OpenInBrowser url={repo.html_url} />
          <Action.CopyToClipboard content={repo.html_url} />
        </ActionPanel>
      }
    />
  );
}
```

## Example 3: Hacker News Reader

Complete Hacker News reader with list and detail views.

```typescript
import { List, ActionPanel, Action, Icon, Color, Detail } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import Parser from "rss-parser";

interface Story {
  title: string;
  link: string;
  pubDate: string;
  contentSnippet: string;
  creator: string;
}

const parser = new Parser();

async function fetchTopStories(): Promise<Story[]> {
  const feed = await parser.parseURL("https://hnrss.org/frontpage");
  return feed.items.map((item) => ({
    title: item.title || "",
    link: item.link || "",
    pubDate: item.pubDate || "",
    contentSnippet: item.contentSnippet || "",
    creator: item.creator || "Unknown",
  }));
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(fetchTopStories);

  return (
    <List isLoading={isLoading}>
      {data?.map((story, index) => (
        <List.Item
          key={story.link}
          title={story.title}
          subtitle={story.creator}
          icon={{ source: Icon.Text, tintColor: Color.Orange }}
          accessories={[
            { text: `#${index + 1}` },
            { date: new Date(story.pubDate) },
          ]}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={story.link} />
              <Action.CopyToClipboard
                title="Copy Link"
                content={story.link}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
              <Action.Push
                title="Show Details"
                icon={Icon.Eye}
                target={<StoryDetail story={story} />}
                shortcut={{ modifiers: ["cmd"], key: "d" }}
              />
              <ActionPanel.Section>
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  onAction={revalidate}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function StoryDetail({ story }: { story: Story }) {
  const markdown = `
# ${story.title}

**Author**: ${story.creator}
**Published**: ${new Date(story.pubDate).toLocaleString()}

---

${story.contentSnippet}

[Read on Hacker News →](${story.link})
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={story.title}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser url={story.link} />
          <Action.CopyToClipboard content={story.link} />
        </ActionPanel>
      }
    />
  );
}
```

## Example 4: Note Taking App with Forms

Complete note-taking application with create, edit, and delete functionality.

```typescript
import {
  List,
  ActionPanel,
  Action,
  Form,
  Icon,
  Color,
  showToast,
  Toast,
  confirmAlert,
  Alert,
  useNavigation,
} from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";
import { useState } from "react";

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export default function Command() {
  const { value: notes = [], setValue: setNotes, isLoading } = useLocalStorage<Note[]>("notes", []);
  const [searchText, setSearchText] = useState("");

  const filteredNotes = notes.filter(
    (note) =>
      note.title.toLowerCase().includes(searchText.toLowerCase()) ||
      note.content.toLowerCase().includes(searchText.toLowerCase()) ||
      note.tags.some((tag) => tag.toLowerCase().includes(searchText.toLowerCase()))
  );

  async function createNote(values: { title: string; content: string; tags: string[] }) {
    const newNote: Note = {
      id: Date.now().toString(),
      title: values.title,
      content: values.content,
      tags: values.tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await setNotes([newNote, ...notes]);
    await showToast(Toast.Style.Success, "Note created");
  }

  async function updateNote(id: string, values: { title: string; content: string; tags: string[] }) {
    await setNotes(
      notes.map((note) =>
        note.id === id
          ? { ...note, ...values, updatedAt: new Date().toISOString() }
          : note
      )
    );
    await showToast(Toast.Style.Success, "Note updated");
  }

  async function deleteNote(id: string) {
    const confirmed = await confirmAlert({
      title: "Delete Note",
      message: "Are you sure? This action cannot be undone.",
      primaryAction: {
        title: "Delete",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (confirmed) {
      await setNotes(notes.filter((note) => note.id !== id));
      await showToast(Toast.Style.Success, "Note deleted");
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search notes..."
      onSearchTextChange={setSearchText}
    >
      {filteredNotes.map((note) => (
        <List.Item
          key={note.id}
          title={note.title}
          subtitle={note.content.substring(0, 50)}
          icon={{ source: Icon.Document, tintColor: Color.Blue }}
          accessories={[
            ...note.tags.map((tag) => ({ tag })),
            { date: new Date(note.updatedAt) },
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                title="View Note"
                icon={Icon.Eye}
                target={<NoteDetail note={note} onDelete={deleteNote} onUpdate={updateNote} />}
              />
              <Action.Push
                title="Edit Note"
                icon={Icon.Pencil}
                target={
                  <NoteForm
                    note={note}
                    onSubmit={(values) => updateNote(note.id, values)}
                  />
                }
                shortcut={{ modifiers: ["cmd"], key: "e" }}
              />
              <ActionPanel.Section>
                <Action.Push
                  title="New Note"
                  icon={Icon.Plus}
                  target={<NoteForm onSubmit={createNote} />}
                  shortcut={{ modifiers: ["cmd"], key: "n" }}
                />
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action
                  title="Delete Note"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => deleteNote(note.id)}
                  shortcut={{ modifiers: ["cmd"], key: "delete" }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}

      {notes.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Notes"
          description="Press ⌘ N to create your first note"
          icon={Icon.Document}
        />
      )}
    </List>
  );
}

function NoteForm({
  note,
  onSubmit,
}: {
  note?: Note;
  onSubmit: (values: { title: string; content: string; tags: string[] }) => void;
}) {
  const { pop } = useNavigation();

  function handleSubmit(values: { title: string; content: string; tags: string[] }) {
    onSubmit(values);
    pop();
  }

  return (
    <Form
      navigationTitle={note ? "Edit Note" : "New Note"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={note ? "Update" : "Create"} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        placeholder="Note title"
        defaultValue={note?.title}
      />
      <Form.TextArea
        id="content"
        title="Content"
        placeholder="Write your note..."
        defaultValue={note?.content}
        enableMarkdown
      />
      <Form.TagPicker id="tags" title="Tags" defaultValue={note?.tags}>
        <Form.TagPicker.Item value="work" title="Work" icon={Icon.Briefcase} />
        <Form.TagPicker.Item value="personal" title="Personal" icon={Icon.Person} />
        <Form.TagPicker.Item value="ideas" title="Ideas" icon={Icon.LightBulb} />
        <Form.TagPicker.Item value="important" title="Important" icon={Icon.Star} />
      </Form.TagPicker>
    </Form>
  );
}

function NoteDetail({
  note,
  onDelete,
  onUpdate,
}: {
  note: Note;
  onDelete: (id: string) => void;
  onUpdate: (id: string, values: { title: string; content: string; tags: string[] }) => void;
}) {
  const markdown = `# ${note.title}\n\n${note.content}`;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={note.title}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Title" text={note.title} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="Tags">
            {note.tags.map((tag) => (
              <Detail.Metadata.TagList.Item key={tag} text={tag} color={Color.Blue} />
            ))}
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Created"
            text={new Date(note.createdAt).toLocaleString()}
          />
          <Detail.Metadata.Label
            title="Updated"
            text={new Date(note.updatedAt).toLocaleString()}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="Edit Note"
            icon={Icon.Pencil}
            target={
              <NoteForm
                note={note}
                onSubmit={(values) => onUpdate(note.id, values)}
              />
            }
            shortcut={{ modifiers: ["cmd"], key: "e" }}
          />
          <Action.CopyToClipboard
            title="Copy Content"
            content={note.content}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <ActionPanel.Section>
            <Action
              title="Delete Note"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              onAction={() => onDelete(note.id)}
              shortcut={{ modifiers: ["cmd"], key: "delete" }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
```

## Example 5: Image Grid Browser

Browse and preview images in a grid layout.

```typescript
import { Grid, ActionPanel, Action, Icon, showInFinder, open } from "@raycast/api";
import { useState } from "react";
import { usePromise } from "@raycast/utils";
import fs from "fs/promises";
import path from "path";

interface ImageFile {
  name: string;
  path: string;
  size: number;
  modified: Date;
}

async function getImages(directory: string): Promise<ImageFile[]> {
  const files = await fs.readdir(directory);
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

  const images: ImageFile[] = [];
  for (const file of files) {
    const filePath = path.join(directory, file);
    const ext = path.extname(file).toLowerCase();

    if (imageExtensions.includes(ext)) {
      const stats = await fs.stat(filePath);
      images.push({
        name: file,
        path: filePath,
        size: stats.size,
        modified: stats.mtime,
      });
    }
  }

  return images.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export default function Command() {
  const [directory] = useState(process.env.HOME + "/Pictures");
  const { data: images, isLoading } = usePromise(getImages, [directory]);

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  return (
    <Grid
      columns={5}
      aspectRatio="1"
      fit="contain"
      isLoading={isLoading}
      searchBarPlaceholder="Search images..."
    >
      {images?.map((image) => (
        <Grid.Item
          key={image.path}
          content={image.path}
          title={image.name}
          subtitle={formatFileSize(image.size)}
          actions={
            <ActionPanel>
              <Action title="Open" onAction={() => open(image.path)} icon={Icon.Eye} />
              <Action
                title="Show in Finder"
                onAction={() => showInFinder(image.path)}
                icon={Icon.Finder}
                shortcut={{ modifiers: ["cmd"], key: "f" }}
              />
              <Action.CopyToClipboard
                title="Copy Path"
                content={image.path}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
              <Action.CopyToClipboard
                title="Copy File Name"
                content={image.name}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}
```

## Example 6: API Integration with Authentication

Extension using API with authentication via preferences.

```typescript
import { List, ActionPanel, Action, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { useFetch } from "@raycast/utils";

interface Preferences {
  apiKey: string;
  baseUrl: string;
}

interface DataItem {
  id: string;
  title: string;
  description: string;
  url: string;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  const { data, isLoading, error } = useFetch<DataItem[]>(
    `${preferences.baseUrl}/api/data`,
    {
      headers: {
        Authorization: `Bearer ${preferences.apiKey}`,
        "Content-Type": "application/json",
      },
      onError: (error) => {
        showToast({
          style: Toast.Style.Failure,
          title: "API Error",
          message: error.message,
        });
      },
    }
  );

  if (error) {
    return (
      <List>
        <List.EmptyView
          title="Authentication Error"
          description="Please check your API key in preferences"
        />
      </List>
    );
  }

  return (
    <List isLoading={isLoading}>
      {data?.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          subtitle={item.description}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={item.url} />
              <Action.CopyToClipboard content={item.url} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

Corresponding `package.json` preferences:

```json
{
  "preferences": [
    {
      "name": "apiKey",
      "type": "password",
      "required": true,
      "title": "API Key",
      "description": "Your API authentication key"
    },
    {
      "name": "baseUrl",
      "type": "textfield",
      "required": true,
      "title": "Base URL",
      "description": "API base URL",
      "default": "https://api.example.com"
    }
  ]
}
```

## Tips for Building Extensions

1. **Always handle loading states** - Use `isLoading` prop to show loading indicators
2. **Implement error handling** - Show toasts or empty views when errors occur
3. **Use caching** - Leverage `useCachedState` and `LocalStorage` for better UX
4. **Add keyboard shortcuts** - Make common actions accessible via shortcuts
5. **Provide empty views** - Show helpful messages when there's no data
6. **Use TypeScript** - Take advantage of full type safety
7. **Throttle search** - Use `throttle` prop on List/Grid for better performance
8. **Validate forms** - Use `useForm` hook for comprehensive validation
9. **Show feedback** - Use toasts to confirm actions
10. **Follow conventions** - Use standard shortcuts and action ordering
