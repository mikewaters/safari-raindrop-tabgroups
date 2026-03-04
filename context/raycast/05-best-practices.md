# Raycast Extension Best Practices

## Development Guidelines

### 1. Project Structure

#### Organize Your Code

```
my-extension/
├── src/
│   ├── components/          # Reusable React components
│   │   ├── ListItem.tsx
│   │   └── DetailView.tsx
│   ├── hooks/               # Custom hooks
│   │   ├── useData.ts
│   │   └── useAuth.ts
│   ├── utils/               # Utility functions
│   │   ├── api.ts
│   │   └── formatters.ts
│   ├── types/               # TypeScript type definitions
│   │   └── index.ts
│   ├── constants/           # Constants and configuration
│   │   └── config.ts
│   └── index.tsx            # Main command file
├── assets/
│   └── icon.png
└── package.json
```

#### File Naming Conventions

- Use PascalCase for component files: `ListItem.tsx`
- Use camelCase for utility files: `formatDate.ts`
- Use kebab-case for command files if multiple: `search-repos.tsx`

### 2. TypeScript Best Practices

#### Define Strong Types

```typescript
// types/index.ts
export interface Repository {
  id: number;
  name: string;
  description: string;
  url: string;
  stars: number;
  language: string;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
  meta?: {
    total: number;
    page: number;
  };
}
```

#### Use Preferences Interface

```typescript
interface Preferences {
  apiKey: string;
  maxResults: string;
  theme: "light" | "dark" | "auto";
}

const preferences = getPreferenceValues<Preferences>();
```

#### Type Component Props

```typescript
interface DetailViewProps {
  item: Repository;
  onDelete: (id: number) => void;
}

function DetailView({ item, onDelete }: DetailViewProps) {
  // ...
}
```

### 3. Performance Optimization

#### Use Throttling for Search

```typescript
<List
  searchBarPlaceholder="Search..."
  onSearchTextChange={setSearchText}
  throttle  // Throttles search input
>
```

#### Implement Caching

```typescript
import { useCachedState, useCachedPromise } from "@raycast/utils";

// Cache state between command runs
const [favorites, setFavorites] = useCachedState<string[]>("favorites", []);

// Cache async operation results
const { data, isLoading } = useCachedPromise(
  async () => {
    const response = await fetch("https://api.example.com/data");
    return response.json();
  }
);
```

#### Keep Previous Data While Loading

```typescript
const { data, isLoading } = useFetch(url, {
  keepPreviousData: true,  // Don't clear data while refetching
});
```

#### Conditional Execution

```typescript
const { data, isLoading } = useFetch(url, {
  execute: searchText.length > 0,  // Only fetch when search text exists
});
```

### 4. User Experience

#### Always Show Loading States

```typescript
export default function Command() {
  const [isLoading, setIsLoading] = useState(true);

  return <List isLoading={isLoading}>{/* ... */}</List>;
}
```

#### Provide Empty Views

```typescript
<List>
  {items.map((item) => (
    <List.Item key={item.id} title={item.title} />
  ))}

  {items.length === 0 && !isLoading && (
    <List.EmptyView
      title="No Items Found"
      description="Try a different search query"
      icon={Icon.MagnifyingGlass}
    />
  )}
</List>
```

#### Use Appropriate Feedback

```typescript
// Success feedback
await showToast({
  style: Toast.Style.Success,
  title: "Item saved",
});

// Error feedback
await showToast({
  style: Toast.Style.Failure,
  title: "Failed to save",
  message: error.message,
});

// Loading feedback
const toast = await showToast({
  style: Toast.Style.Animated,
  title: "Saving...",
});

// Update toast after completion
toast.style = Toast.Style.Success;
toast.title = "Saved!";
```

#### Confirm Destructive Actions

```typescript
const confirmed = await confirmAlert({
  title: "Delete Item",
  message: "This action cannot be undone.",
  primaryAction: {
    title: "Delete",
    style: Alert.ActionStyle.Destructive,
  },
});

if (confirmed) {
  // Perform deletion
}
```

### 5. Navigation

#### Use Navigation API Consistently

```typescript
// Push new view
<Action.Push
  title="Show Details"
  target={<DetailView item={item} />}
/>

// Or using useNavigation
const { push, pop } = useNavigation();

<Action
  title="Show Details"
  onAction={() => push(<DetailView item={item} />)}
/>
```

#### Set Navigation Titles

```typescript
// Only for nested screens, not root commands
<Detail
  markdown={content}
  navigationTitle="Settings"  // Shows in breadcrumb
/>
```

#### Don't Build Custom Navigation

Don't create your own navigation stack - use Raycast's built-in Navigation API for consistency.

### 6. Error Handling

#### Comprehensive Error Handling

```typescript
async function fetchData() {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Fetch error:", error);
    throw error;
  }
}

export default function Command() {
  const { data, error, isLoading } = usePromise(fetchData);

  useEffect(() => {
    if (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load data",
        message: error.message,
      });
    }
  }, [error]);

  return <List isLoading={isLoading}>{/* ... */}</List>;
}
```

#### Provide Recovery Actions

```typescript
await showToast({
  style: Toast.Style.Failure,
  title: "Network Error",
  message: "Failed to connect to server",
  primaryAction: {
    title: "Retry",
    onAction: () => revalidate(),
  },
});
```

### 7. Actions & Shortcuts

#### Organize ActionPanel Logically

```typescript
<ActionPanel>
  {/* Primary actions first */}
  <ActionPanel.Section>
    <Action.OpenInBrowser url={url} />
    <Action.CopyToClipboard content={text} />
  </ActionPanel.Section>

  {/* Secondary actions */}
  <ActionPanel.Section title="Advanced">
    <Action.ShowInFinder path={path} />
    <Action title="Custom Action" onAction={handler} />
  </ActionPanel.Section>

  {/* Destructive actions last */}
  <ActionPanel.Section>
    <Action
      title="Delete"
      style={Action.Style.Destructive}
      onAction={deleteHandler}
    />
  </ActionPanel.Section>
</ActionPanel>
```

#### Use Standard Shortcuts

Follow Raycast conventions:

- `⌘ C` - Copy
- `⌘ O` - Open
- `⌘ N` - New/Create
- `⌘ E` - Edit
- `⌘ R` - Refresh
- `⌘ Delete` - Delete
- `⌘ K` - Action search (built-in, don't override)

```typescript
<Action
  title="Copy"
  onAction={copy}
  shortcut={{ modifiers: ["cmd"], key: "c" }}
/>
```

#### Make Primary Actions Accessible

The first action should be the most common use case:

```typescript
<ActionPanel>
  {/* Most common action - accessible with ↵ */}
  <Action.OpenInBrowser url={url} />

  {/* Less common actions below */}
  <Action.CopyToClipboard content={url} />
</ActionPanel>
```

### 8. Data Management

#### Use LocalStorage for Persistence

```typescript
// Store data
await LocalStorage.setItem("preferences", JSON.stringify(data));

// Retrieve data
const stored = await LocalStorage.getItem<string>("preferences");
const data = stored ? JSON.parse(stored) : defaultValue;

// Remove data
await LocalStorage.removeItem("preferences");
```

#### Use useCachedState for Simple State

```typescript
// Automatically persists between runs
const [favorites, setFavorites] = useCachedState<string[]>("favorites", []);
```

#### Use useLocalStorage Hook

```typescript
const {
  value,
  setValue,
  removeValue,
  isLoading,
} = useLocalStorage<string[]>("items", []);
```

### 9. API Integration

#### Create Reusable API Client

```typescript
// utils/api.ts
import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  apiKey: string;
}

export async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const { apiKey } = getPreferenceValues<Preferences>();

  const response = await fetch(`https://api.example.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }

  return response.json();
}
```

#### Use in Components

```typescript
import { usePromise } from "@raycast/utils";
import { apiRequest } from "./utils/api";

export default function Command() {
  const { data, isLoading, error } = usePromise(async () => {
    return apiRequest<Data[]>("/endpoint");
  });

  return <List isLoading={isLoading}>{/* ... */}</List>;
}
```

### 10. Forms

#### Use useForm for Validation

```typescript
import { useForm, FormValidation } from "@raycast/utils";

const { handleSubmit, itemProps } = useForm<FormValues>({
  onSubmit(values) {
    console.log(values);
  },
  validation: {
    email: FormValidation.Required,
    password: (value) => {
      if (!value) return "Password is required";
      if (value.length < 8) return "Password must be at least 8 characters";
    },
  },
});
```

#### Provide Helpful Placeholders

```typescript
<Form.TextField
  id="email"
  title="Email"
  placeholder="user@example.com"
  info="We'll never share your email"
  {...itemProps.email}
/>
```

#### Use Appropriate Form Components

- `Form.TextField` - Short text (names, emails)
- `Form.TextArea` - Long text (descriptions, notes)
- `Form.Dropdown` - Single selection from options
- `Form.TagPicker` - Multiple selections
- `Form.DatePicker` - Dates and times
- `Form.FilePicker` - File/folder selection
- `Form.Checkbox` - Boolean values

### 11. Accessibility

#### Provide Meaningful Icons

```typescript
<List.Item
  icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
  title="Completed Task"
/>
```

#### Use Descriptive Titles

```typescript
// Good
<Action title="Delete Item" />

// Bad
<Action title="Delete" />  // Too vague
```

#### Add Accessories for Context

```typescript
<List.Item
  title="Task"
  accessories={[
    { tag: { value: "Urgent", color: Color.Red } },
    { date: dueDate },
    { text: "3 comments" },
  ]}
/>
```

### 12. Security

#### Use Password Type for Sensitive Data

```json
{
  "preferences": [
    {
      "name": "apiKey",
      "type": "password",  // Stored encrypted
      "required": true,
      "title": "API Key"
    }
  ]
}
```

#### Don't Log Sensitive Information

```typescript
// Bad
console.log("API Key:", apiKey);

// Good
console.log("Making API request...");
```

#### Validate User Input

```typescript
function validateUrl(value: string): string | undefined {
  try {
    new URL(value);
    return undefined;
  } catch {
    return "Please enter a valid URL";
  }
}
```

### 13. Testing & Debugging

#### Use Console Logging

```typescript
console.log("Data fetched:", data);
console.error("Error occurred:", error);
console.warn("Deprecated feature used");
```

#### Use React Developer Tools

1. Run `npm run dev`
2. Open command in Raycast
3. Press `⌘ ⌥ D` to launch React DevTools

#### Handle Edge Cases

```typescript
// Handle empty data
if (!data || data.length === 0) {
  return <List.EmptyView title="No data" />;
}

// Handle missing properties
const title = item.title || "Untitled";
const description = item.description || "No description";
```

### 14. Documentation

#### Add Clear README

```markdown
# My Extension

Brief description of what the extension does.

## Features

- Feature 1
- Feature 2

## Setup

1. Get API key from [service.com](https://service.com)
2. Add API key in extension preferences

## Usage

How to use the extension...
```

#### Document Preferences

```json
{
  "name": "apiKey",
  "title": "API Key",
  "description": "Get your API key from https://example.com/settings",
  "placeholder": "Enter your API key"
}
```

### 15. Extension Store Guidelines

#### Icon Requirements

- Size: 512x512px
- Format: PNG
- Style: Simple, clear, recognizable
- No text in icon

#### Metadata

```json
{
  "name": "my-extension",
  "title": "My Extension",
  "description": "Clear, concise description of what it does",
  "icon": "icon.png",
  "author": "yourname",
  "categories": ["Productivity"],
  "license": "MIT"
}
```

#### Screenshots

Include screenshots showing:
- Main functionality
- Different views/modes
- Settings/preferences (if complex)

## Common Patterns

### Pattern 1: List → Detail Navigation

```typescript
// Main list view
export default function Command() {
  return (
    <List>
      <List.Item
        title="Item"
        actions={
          <ActionPanel>
            <Action.Push target={<DetailView />} />
          </ActionPanel>
        }
      />
    </List>
  );
}

// Detail view
function DetailView() {
  return <Detail markdown="# Details" />;
}
```

### Pattern 2: List → Form → List

```typescript
export default function Command() {
  const [items, setItems] = useState([]);

  function addItem(values: FormValues) {
    setItems([...items, values]);
  }

  return (
    <List>
      {items.map((item) => (
        <List.Item key={item.id} title={item.title} />
      ))}
      <List.Item
        title="Add Item"
        actions={
          <ActionPanel>
            <Action.Push target={<ItemForm onSubmit={addItem} />} />
          </ActionPanel>
        }
      />
    </List>
  );
}
```

### Pattern 3: Async Data Loading

```typescript
export default function Command() {
  const { data, isLoading, error, revalidate } = usePromise(fetchData);

  if (error) {
    return (
      <List>
        <List.EmptyView
          title="Error"
          description={error.message}
          actions={
            <ActionPanel>
              <Action title="Retry" onAction={revalidate} />
            </ActionPanel>
          }
        />
      </List>
    );
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

## Performance Checklist

- [ ] Use `throttle` for search inputs
- [ ] Implement `keepPreviousData` for better UX
- [ ] Cache frequently accessed data
- [ ] Use conditional execution for expensive operations
- [ ] Avoid unnecessary re-renders
- [ ] Optimize large lists with sections
- [ ] Use `useMemo` for expensive computations
- [ ] Use `useCallback` for stable function references

## Quality Checklist

- [ ] All async operations have loading states
- [ ] Errors are handled and displayed
- [ ] Empty states are provided
- [ ] Destructive actions require confirmation
- [ ] Forms have validation
- [ ] Actions have appropriate shortcuts
- [ ] Icons and colors are used meaningfully
- [ ] TypeScript types are defined
- [ ] Code is organized into logical files
- [ ] Extension has clear README
- [ ] Preferences have descriptions
- [ ] Extension follows naming conventions
