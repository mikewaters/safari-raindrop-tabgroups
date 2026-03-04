# Raycast API Reference

## Overview

The Raycast API provides utilities, hooks, storage, navigation, and system integrations to build powerful extensions. This document covers all major APIs beyond UI components.

## React Hooks

Raycast provides specialized hooks that build on React's foundation and incorporate best practices for async operations, caching, and state management.

### Standard React Hooks

All standard React hooks work in Raycast extensions:

```typescript
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
```

#### useState Example

```typescript
import { List } from "@raycast/api";
import { useState } from "react";

export default function Command() {
  const [items, setItems] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  return <List isLoading={isLoading}>{/* ... */}</List>;
}
```

#### useEffect Example

```typescript
import { useEffect, useState } from "react";
import { List, showToast, Toast } from "@raycast/api";

export default function Command() {
  const [data, setData] = useState([]);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch("https://api.example.com/data");
        const json = await response.json();
        setData(json);
      } catch (err) {
        setError(err as Error);
      }
    }
    fetchData();
  }, []);

  useEffect(() => {
    if (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load data",
        message: error.message,
      });
    }
  }, [error]);

  return <List>{/* ... */}</List>;
}
```

### useCachedState

Returns a stateful value and update function (like `useState`) but the value is persisted between command runs.

```typescript
import { List } from "@raycast/api";
import { useCachedState } from "@raycast/utils";

export default function Command() {
  const [searchText, setSearchText] = useCachedState("search-text", "");

  return (
    <List searchText={searchText} onSearchTextChange={setSearchText}>
      {/* Items */}
    </List>
  );
}
```

### usePromise

Wraps an asynchronous function or promise and returns:
- `data`: Result of the promise
- `isLoading`: Loading state
- `error`: Error if promise rejected
- `revalidate`: Function to re-run the promise

```typescript
import { List } from "@raycast/api";
import { usePromise } from "@raycast/utils";

async function fetchStories() {
  const response = await fetch("https://api.example.com/stories");
  return response.json();
}

export default function Command() {
  const { data, isLoading, error, revalidate } = usePromise(fetchStories);

  return (
    <List isLoading={isLoading}>
      {data?.map((story) => (
        <List.Item key={story.id} title={story.title} />
      ))}
    </List>
  );
}
```

#### usePromise with Arguments

```typescript
const { data, isLoading } = usePromise(
  async (query: string) => {
    const response = await fetch(`https://api.example.com/search?q=${query}`);
    return response.json();
  },
  ["initial query"]  // Initial arguments
);
```

### useFetch

Specialized hook for fetching data from APIs. Built on top of `usePromise`.

```typescript
import { List } from "@raycast/api";
import { useFetch } from "@raycast/utils";

export default function Command() {
  const { data, isLoading } = useFetch("https://api.github.com/users/octocat");

  return (
    <List isLoading={isLoading}>
      {data && <List.Item title={data.name} subtitle={data.bio} />}
    </List>
  );
}
```

#### useFetch with Options

```typescript
const { data, isLoading, error, revalidate } = useFetch(
  "https://api.example.com/data",
  {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({ key: "value" }),
    keepPreviousData: true,  // Keep old data while fetching new
    execute: searchText.length > 0,  // Conditional execution
    onError: (error) => {
      console.error(error);
    },
    onData: (data) => {
      console.log("Data received:", data);
    },
  }
);
```

### useExec

Execute shell commands and handle output.

```typescript
import { List } from "@raycast/api";
import { useExec } from "@raycast/utils";

export default function Command() {
  const { data, isLoading } = useExec("ls", ["-la"], {
    cwd: "/Users/username/Documents",
  });

  return (
    <List isLoading={isLoading}>
      {data && <List.Item title={data} />}
    </List>
  );
}
```

### useForm

High-level interface for working with forms, including validation.

```typescript
import { Form, ActionPanel, Action } from "@raycast/api";
import { useForm, FormValidation } from "@raycast/utils";

interface FormValues {
  name: string;
  email: string;
  age: string;
}

export default function Command() {
  const { handleSubmit, itemProps } = useForm<FormValues>({
    onSubmit(values) {
      console.log("Submitted:", values);
    },
    validation: {
      name: FormValidation.Required,
      email: (value) => {
        if (!value) return "Email is required";
        if (!value.includes("@")) return "Invalid email";
      },
      age: (value) => {
        const num = parseInt(value || "0");
        if (num < 18) return "Must be 18 or older";
      },
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField title="Name" {...itemProps.name} />
      <Form.TextField title="Email" {...itemProps.email} />
      <Form.TextField title="Age" {...itemProps.age} />
    </Form>
  );
}
```

### useNavigation

Access navigation functions to push and pop views.

```typescript
import { List, ActionPanel, Action, Detail } from "@raycast/api";
import { useNavigation } from "@raycast/api";

function DetailView({ item }: { item: string }) {
  const { pop } = useNavigation();

  return (
    <Detail
      markdown={`# ${item}`}
      actions={
        <ActionPanel>
          <Action title="Go Back" onAction={pop} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const { push } = useNavigation();

  return (
    <List>
      <List.Item
        title="Item 1"
        actions={
          <ActionPanel>
            <Action
              title="Show Details"
              onAction={() => push(<DetailView item="Item 1" />)}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
```

### useLocalStorage

Hook for managing values in local storage.

```typescript
import { List } from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";

export default function Command() {
  const { value, setValue, isLoading, removeValue } = useLocalStorage(
    "favorites",
    []
  );

  return (
    <List isLoading={isLoading}>
      {value?.map((item) => (
        <List.Item key={item} title={item} />
      ))}
    </List>
  );
}
```

## Storage & Persistence

### LocalStorage

Store data locally in Raycast's encrypted database. All commands in an extension share storage access.

#### LocalStorage.getItem

```typescript
import { LocalStorage } from "@raycast/api";

const value = await LocalStorage.getItem<string>("key");
// Returns string | undefined
```

#### LocalStorage.setItem

```typescript
await LocalStorage.setItem("key", "value");
```

#### LocalStorage.removeItem

```typescript
await LocalStorage.removeItem("key");
```

#### LocalStorage.allItems

```typescript
const items = await LocalStorage.allItems();
// Returns Record<string, string>
console.log(items); // { "key1": "value1", "key2": "value2" }
```

#### LocalStorage.clear

```typescript
await LocalStorage.clear();
```

#### Complete Example

```typescript
import { List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";

export default function Command() {
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    async function loadFavorites() {
      const stored = await LocalStorage.getItem<string>("favorites");
      if (stored) {
        setFavorites(JSON.parse(stored));
      }
    }
    loadFavorites();
  }, []);

  async function addFavorite(item: string) {
    const updated = [...favorites, item];
    setFavorites(updated);
    await LocalStorage.setItem("favorites", JSON.stringify(updated));
    showToast(Toast.Style.Success, "Added to favorites");
  }

  return (
    <List>
      {favorites.map((item) => (
        <List.Item key={item} title={item} />
      ))}
    </List>
  );
}
```

## Preferences

Preferences make extensions configurable. They're defined in `package.json` and accessed via `getPreferenceValues()`.

### Defining Preferences

In `package.json`:

```json
{
  "preferences": [
    {
      "name": "apiKey",
      "type": "password",
      "required": true,
      "title": "API Key",
      "description": "Your API key for authentication",
      "placeholder": "Enter your API key"
    },
    {
      "name": "maxResults",
      "type": "textfield",
      "required": false,
      "title": "Max Results",
      "description": "Maximum number of results to show",
      "default": "10"
    },
    {
      "name": "enableNotifications",
      "type": "checkbox",
      "required": false,
      "title": "Enable Notifications",
      "description": "Show notifications for updates",
      "default": false,
      "label": "Enable"
    },
    {
      "name": "theme",
      "type": "dropdown",
      "required": false,
      "title": "Theme",
      "description": "Select color theme",
      "default": "auto",
      "data": [
        { "title": "Auto", "value": "auto" },
        { "title": "Light", "value": "light" },
        { "title": "Dark", "value": "dark" }
      ]
    }
  ]
}
```

### Preference Types

- `password`: Secure text input (encrypted storage)
- `textfield`: Plain text input
- `checkbox`: Boolean toggle
- `dropdown`: Select from options
- `appPicker`: Select an application
- `file`: File path selector
- `directory`: Directory path selector

### Accessing Preferences

```typescript
import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  apiKey: string;
  maxResults: string;
  enableNotifications: boolean;
  theme: "auto" | "light" | "dark";
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  console.log(preferences.apiKey);
  console.log(preferences.maxResults);
  console.log(preferences.enableNotifications);
  console.log(preferences.theme);

  // Use preferences in your extension...
}
```

### Per-Command Preferences

Define preferences specific to a command:

```json
{
  "commands": [
    {
      "name": "search",
      "title": "Search",
      "preferences": [
        {
          "name": "searchEngine",
          "type": "dropdown",
          "title": "Search Engine",
          "data": [
            { "title": "Google", "value": "google" },
            { "title": "Bing", "value": "bing" }
          ]
        }
      ]
    }
  ]
}
```

## Navigation

Navigate between screens using the Navigation API.

### push

Push a new view onto the navigation stack:

```typescript
import { List, ActionPanel, Action, Detail } from "@raycast/api";

function DetailScreen({ title }: { title: string }) {
  return <Detail markdown={`# ${title}`} navigationTitle={title} />;
}

export default function Command() {
  return (
    <List>
      <List.Item
        title="Item 1"
        actions={
          <ActionPanel>
            <Action.Push title="Show Details" target={<DetailScreen title="Item 1" />} />
          </ActionPanel>
        }
      />
    </List>
  );
}
```

### pop

Return to the previous screen:

```typescript
import { Detail, ActionPanel, Action } from "@raycast/api";
import { useNavigation } from "@raycast/api";

export function DetailScreen() {
  const { pop } = useNavigation();

  return (
    <Detail
      markdown="# Details"
      actions={
        <ActionPanel>
          <Action title="Go Back" onAction={pop} />
        </ActionPanel>
      }
    />
  );
}
```

### navigationTitle

Set title for nested screens:

```typescript
<Detail markdown="Content" navigationTitle="Settings" />
```

**Best Practice**: Don't set `navigationTitle` on root commands - it's automatically set to the command name.

## Feedback Components

### Toast

Show temporary notifications during async operations or to confirm actions.

```typescript
import { showToast, Toast } from "@raycast/api";

// Success toast
await showToast({
  style: Toast.Style.Success,
  title: "Task completed",
  message: "Your task was completed successfully",
});

// Failure toast
await showToast({
  style: Toast.Style.Failure,
  title: "Error occurred",
  message: error.message,
});

// Animated toast (loading)
const toast = await showToast({
  style: Toast.Style.Animated,
  title: "Loading...",
});

// Update toast after operation
setTimeout(() => {
  toast.style = Toast.Style.Success;
  toast.title = "Completed!";
}, 2000);
```

#### Toast with Actions

```typescript
await showToast({
  style: Toast.Style.Failure,
  title: "Failed to copy",
  message: "Could not copy to clipboard",
  primaryAction: {
    title: "Retry",
    onAction: () => {
      // Retry logic
    },
  },
  secondaryAction: {
    title: "Copy Error",
    onAction: () => {
      Clipboard.copy(error.stack);
    },
  },
});
```

### Alert

Show confirmation dialogs:

```typescript
import { confirmAlert, Alert } from "@raycast/api";

const confirmed = await confirmAlert({
  title: "Delete Item",
  message: "Are you sure you want to delete this item?",
  primaryAction: {
    title: "Delete",
    style: Alert.ActionStyle.Destructive,
  },
});

if (confirmed) {
  // Perform deletion
}
```

#### Alert with Custom Actions

```typescript
import { showAlert, Alert } from "@raycast/api";

const options: Alert.Options = {
  title: "Save Changes",
  message: "Do you want to save your changes?",
  primaryAction: {
    title: "Save",
    onAction: () => {
      // Save logic
    },
  },
  dismissAction: {
    title: "Don't Save",
    onAction: () => {
      // Discard changes
    },
  },
};

await showAlert(options);
```

### HUD

Show a heads-up display when closing Raycast (e.g., after copying to clipboard):

```typescript
import { showHUD, Clipboard } from "@raycast/api";

export default async function Command() {
  await Clipboard.copy("Copied text");
  await showHUD("✅ Copied to Clipboard");
}
```

## System Utilities

### Clipboard

```typescript
import { Clipboard } from "@raycast/api";

// Copy text
await Clipboard.copy("Text to copy");

// Copy text with transient option (concealed from clipboard managers)
await Clipboard.copy("Sensitive text", { concealed: true });

// Read from clipboard
const text = await Clipboard.readText();
console.log(text);

// Paste text
await Clipboard.paste("Text to paste");

// Clear clipboard
await Clipboard.clear();
```

### Environment

Access environment information:

```typescript
import { environment } from "@raycast/api";

console.log(environment.commandName);      // Current command name
console.log(environment.commandMode);      // "view" | "no-view" | "menu-bar"
console.log(environment.extensionName);    // Extension name
console.log(environment.isDevelopment);    // true if in dev mode
console.log(environment.supportPath);      // Path to support directory
console.log(environment.assetsPath);       // Path to assets directory
console.log(environment.raycastVersion);   // Raycast version
console.log(environment.appearance);       // "light" | "dark"
```

### Open

Open files, folders, and URLs:

```typescript
import { open } from "@raycast/api";

// Open URL in default browser
await open("https://example.com");

// Open file with default application
await open("/path/to/file.pdf");

// Open file with specific application
await open("/path/to/file.txt", "Visual Studio Code");

// Open folder in Finder
await open("/path/to/folder");
```

### showInFinder

Show file or folder in Finder:

```typescript
import { showInFinder } from "@raycast/api";

await showInFinder("/path/to/file");
```

### Trash

Move files to trash:

```typescript
import { trash } from "@raycast/api";

await trash("/path/to/file");
// or multiple files
await trash(["/path/to/file1", "/path/to/file2"]);
```

### getSelectedFinderItems

Get selected items in Finder:

```typescript
import { getSelectedFinderItems } from "@raycast/api";

const items = await getSelectedFinderItems();
items.forEach((item) => {
  console.log(item.path);
});
```

### getSelectedText

Get currently selected text from active application:

```typescript
import { getSelectedText } from "@raycast/api";

const text = await getSelectedText();
console.log(text);
```

## Cache

Use cache to improve performance:

```typescript
import { Cache } from "@raycast/api";

const cache = new Cache();

// Set value
cache.set("key", JSON.stringify({ data: "value" }));

// Get value
const value = cache.get("key");
if (value) {
  const data = JSON.parse(value);
}

// Check if key exists
if (cache.has("key")) {
  // ...
}

// Remove value
cache.remove("key");

// Clear all
cache.clear();
```

### useCachedPromise

Combine caching with async operations:

```typescript
import { useCachedPromise } from "@raycast/utils";

const { data, isLoading } = useCachedPromise(
  async (query: string) => {
    const response = await fetch(`https://api.example.com/search?q=${query}`);
    return response.json();
  },
  ["initial query"],
  {
    keepPreviousData: true,
  }
);
```

## Error Handling Best Practices

```typescript
import { List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";

async function fetchData() {
  const response = await fetch("https://api.example.com/data");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export default function Command() {
  const { data, isLoading, error } = usePromise(fetchData);

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to load data",
      message: error.message,
    });
  }

  return (
    <List isLoading={isLoading}>
      {data?.map((item) => (
        <List.Item key={item.id} title={item.title} />
      ))}
    </List>
  );
}
```

## TypeScript Types

Raycast API is fully typed. Import types as needed:

```typescript
import type {
  LaunchProps,
  Form,
  List,
  ActionPanel,
  Image,
} from "@raycast/api";

interface CommandProps extends LaunchProps {
  // ...
}
```
