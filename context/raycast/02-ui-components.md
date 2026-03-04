# Raycast UI Components Reference

## Overview

Raycast provides a set of UI components that function as a native design system. All components are rendered natively (not in a browser DOM), providing fast, consistent experiences.

## Component Architecture

- **High-level components**: List, Grid, Detail, Form
- **Item components**: Nested within high-level components
- **ActionPanel**: Contains interactive actions with keyboard shortcuts
- **Feedback components**: Toast, Alert, HUD for user feedback

## Main UI Components

### 1. List Component

Shows multiple similar items in a list format. Perfect for displaying collections of data.

#### Basic Usage

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item title="First Item" />
      <List.Item title="Second Item" />
    </List>
  );
}
```

#### List Props

```typescript
interface List {
  isLoading?: boolean;              // Show loading indicator
  searchBarPlaceholder?: string;    // Search bar placeholder text
  onSearchTextChange?: (text: string) => void;  // Search callback
  searchText?: string;               // Controlled search text
  navigationTitle?: string;          // Title for nested screens
  filtering?: boolean | { keepSectionOrder: boolean };  // Enable/configure filtering
  throttle?: boolean;                // Throttle search input
  selectedItemId?: string;           // Controlled selected item
  onSelectionChange?: (id: string) => void;  // Selection callback
  searchBarAccessory?: React.ReactNode;  // Accessory in search bar
  actions?: React.ReactNode;         // Default actions (ActionPanel)
}
```

#### List.Item Props

```typescript
interface ListItem {
  title: string;                     // Required: Item title
  subtitle?: string;                 // Optional subtitle
  accessories?: Accessory[];         // Right-side accessories (tags, icons, text)
  icon?: Image.ImageLike;           // Left icon
  keywords?: string[];              // Additional search keywords
  actions?: React.ReactNode;        // ActionPanel for this item
  id?: string;                      // Unique identifier
  detail?: React.ReactNode;         // Detail view (List.Item.Detail)
}
```

#### List with Search

```typescript
import { List } from "@raycast/api";
import { useState } from "react";

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [items, setItems] = useState(["Apple", "Banana", "Cherry"]);

  const filteredItems = items.filter((item) =>
    item.toLowerCase().includes(searchText.toLowerCase())
  );

  return (
    <List
      searchBarPlaceholder="Search fruits..."
      onSearchTextChange={setSearchText}
    >
      {filteredItems.map((item) => (
        <List.Item key={item} title={item} />
      ))}
    </List>
  );
}
```

#### List with Sections

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Section title="Fruits">
        <List.Item title="Apple" />
        <List.Item title="Banana" />
      </List.Section>
      <List.Section title="Vegetables">
        <List.Item title="Carrot" />
        <List.Item title="Broccoli" />
      </List.Section>
    </List>
  );
}
```

#### List with Accessories

```typescript
import { List, Icon, Color } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item
        title="Task 1"
        accessories={[
          { text: "High Priority", icon: Icon.ExclamationMark },
          { tag: { value: "Urgent", color: Color.Red } },
          { date: new Date() },
        ]}
      />
    </List>
  );
}
```

#### List.Item.Detail

Show detailed information in the right panel:

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List isShowingDetail>
      <List.Item
        title="Item 1"
        detail={
          <List.Item.Detail
            markdown="# Hello\n\nThis is **markdown** content"
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label
                  title="Author"
                  text="John Doe"
                />
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.Link
                  title="Website"
                  text="example.com"
                  target="https://example.com"
                />
              </List.Item.Detail.Metadata>
            }
          />
        }
      />
    </List>
  );
}
```

### 2. Grid Component

Similar to List but displays items in a grid layout with images. Perfect for visual content like icons, photos, or cards.

#### Basic Usage

```typescript
import { Grid } from "@raycast/api";

export default function Command() {
  return (
    <Grid>
      <Grid.Item
        content="https://via.placeholder.com/150"
        title="Image 1"
      />
      <Grid.Item
        content="https://via.placeholder.com/150"
        title="Image 2"
      />
    </Grid>
  );
}
```

#### Grid Props

```typescript
interface Grid {
  isLoading?: boolean;
  columns?: number;                  // Number of columns (default: 5)
  aspectRatio?: "1" | "3/2" | "2/3" | "4/3" | "3/4" | "16/9" | "9/16";
  fit?: "contain" | "fill";         // How images fit in cells
  searchBarPlaceholder?: string;
  onSearchTextChange?: (text: string) => void;
  navigationTitle?: string;
  filtering?: boolean | { keepSectionOrder: boolean };
  throttle?: boolean;
  selectedItemId?: string;
  onSelectionChange?: (id: string) => void;
  actions?: React.ReactNode;
  searchBarAccessory?: React.ReactNode;
}
```

#### Grid.Item Props

```typescript
interface GridItem {
  content: Image.ImageLike;          // Required: Image source
  title?: string;
  subtitle?: string;
  accessories?: Accessory[];
  keywords?: string[];
  actions?: React.ReactNode;
  id?: string;
}
```

#### Grid with Sections and Sizing

```typescript
import { Grid } from "@raycast/api";

export default function Command() {
  return (
    <Grid columns={4} aspectRatio="1" fit="contain">
      <Grid.Section title="Icons">
        <Grid.Item content={Icon.Checkmark} title="Checkmark" />
        <Grid.Item content={Icon.Circle} title="Circle" />
      </Grid.Section>
      <Grid.Section title="Images">
        <Grid.Item
          content="https://example.com/image.png"
          title="Example Image"
        />
      </Grid.Section>
    </Grid>
  );
}
```

### 3. Detail Component

Displays detailed information, typically markdown content with optional metadata sidebar.

#### Basic Usage

```typescript
import { Detail } from "@raycast/api";

export default function Command() {
  const markdown = `
# Hello World

This is a **detail** view with *markdown* support.

- Item 1
- Item 2
- Item 3

\`\`\`javascript
console.log("Code blocks work too!");
\`\`\`
  `;

  return <Detail markdown={markdown} />;
}
```

#### Detail Props

```typescript
interface Detail {
  markdown?: string;                 // Markdown content
  isLoading?: boolean;
  actions?: React.ReactNode;
  navigationTitle?: string;
  metadata?: React.ReactNode;        // Detail.Metadata component
}
```

#### Detail with Metadata

```typescript
import { Detail } from "@raycast/api";

export default function Command() {
  return (
    <Detail
      markdown="# Project Details\n\nThis project is awesome!"
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Status" text="Active" />
          <Detail.Metadata.Label
            title="Priority"
            text="High"
            icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Link
            title="Repository"
            text="github.com/user/repo"
            target="https://github.com/user/repo"
          />
          <Detail.Metadata.TagList title="Tags">
            <Detail.Metadata.TagList.Item text="TypeScript" color={Color.Blue} />
            <Detail.Metadata.TagList.Item text="React" color={Color.Purple} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Created" text="2024-01-15" />
        </Detail.Metadata>
      }
    />
  );
}
```

#### Detail with Loading State

```typescript
import { Detail } from "@raycast/api";
import { useState, useEffect } from "react";

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [markdown, setMarkdown] = useState("");

  useEffect(() => {
    // Simulate async data loading
    setTimeout(() => {
      setMarkdown("# Data Loaded!\n\nContent is ready.");
      setIsLoading(false);
    }, 2000);
  }, []);

  return <Detail isLoading={isLoading} markdown={markdown} />;
}
```

### 4. Form Component

Creates forms for user input. Forms are used to collect data like creating issues, adding tasks, or configuring settings.

#### Basic Usage

```typescript
import { Form, ActionPanel, Action } from "@raycast/api";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit"
            onSubmit={(values) => console.log(values)}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Enter your name" />
      <Form.TextArea id="bio" title="Bio" placeholder="Tell us about yourself" />
      <Form.Checkbox id="subscribe" label="Subscribe to newsletter" />
    </Form>
  );
}
```

#### Form Components

##### Form.TextField

```typescript
<Form.TextField
  id="email"
  title="Email"
  placeholder="user@example.com"
  defaultValue=""
  error="Invalid email"
  onChange={(newValue) => console.log(newValue)}
  onBlur={(event) => console.log("Blur")}
  info="Your email will be kept private"
/>
```

##### Form.TextArea

```typescript
<Form.TextArea
  id="description"
  title="Description"
  placeholder="Enter description..."
  enableMarkdown={true}  // Show markdown preview
/>
```

##### Form.Checkbox

```typescript
<Form.Checkbox
  id="agree"
  label="I agree to terms"
  defaultValue={false}
  storeValue={true}  // Remember value
/>
```

##### Form.Dropdown

```typescript
<Form.Dropdown id="priority" title="Priority" defaultValue="medium">
  <Form.Dropdown.Item value="low" title="Low" />
  <Form.Dropdown.Item value="medium" title="Medium" />
  <Form.Dropdown.Item value="high" title="High" />
</Form.Dropdown>
```

##### Form.DatePicker

```typescript
<Form.DatePicker
  id="dueDate"
  title="Due Date"
  type={Form.DatePicker.Type.Date}  // Date, DateTime
/>
```

##### Form.TagPicker

```typescript
<Form.TagPicker id="tags" title="Tags">
  <Form.TagPicker.Item value="bug" title="Bug" icon={Icon.Bug} />
  <Form.TagPicker.Item value="feature" title="Feature" icon={Icon.Star} />
</Form.TagPicker>
```

##### Form.FilePicker

```typescript
<Form.FilePicker
  id="files"
  title="Files"
  allowMultipleSelection={true}
  canChooseDirectories={false}
  canChooseFiles={true}
/>
```

##### Form.Separator & Form.Description

```typescript
<Form.Description text="Please fill out the form below" />
<Form.Separator />
```

#### Complete Form Example

```typescript
import { Form, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useState } from "react";

export default function Command() {
  const [nameError, setNameError] = useState<string | undefined>();

  function validateName(value: string | undefined) {
    if (!value || value.length === 0) {
      setNameError("Name is required");
    } else if (value.length < 3) {
      setNameError("Name must be at least 3 characters");
    } else {
      setNameError(undefined);
    }
  }

  async function handleSubmit(values: FormValues) {
    if (nameError) {
      showToast({
        style: Toast.Style.Failure,
        title: "Validation Error",
        message: "Please fix errors before submitting",
      });
      return;
    }

    showToast({
      style: Toast.Style.Success,
      title: "Form Submitted",
      message: `Hello, ${values.name}!`,
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="John Doe"
        error={nameError}
        onChange={validateName}
        onBlur={(event) => validateName(event.target.value)}
      />
      <Form.TextField
        id="email"
        title="Email"
        placeholder="john@example.com"
      />
      <Form.Dropdown id="role" title="Role" defaultValue="developer">
        <Form.Dropdown.Item value="developer" title="Developer" />
        <Form.Dropdown.Item value="designer" title="Designer" />
        <Form.Dropdown.Item value="manager" title="Manager" />
      </Form.Dropdown>
      <Form.TagPicker id="skills" title="Skills">
        <Form.TagPicker.Item value="js" title="JavaScript" />
        <Form.TagPicker.Item value="ts" title="TypeScript" />
        <Form.TagPicker.Item value="react" title="React" />
      </Form.TagPicker>
      <Form.Checkbox id="available" label="Available for work" />
    </Form>
  );
}
```

## ActionPanel & Actions

ActionPanel contains actions that users can trigger. Actions are associated with keyboard shortcuts.

### Default Keyboard Shortcuts

- **List/Grid/Detail**: Primary action (↵), Secondary action (⌘ ↵)
- **Form**: Primary action (⌘ ↵), Secondary action (⌘ ⇧ ↵)
- **⌘ K**: Open action search

### ActionPanel Structure

```typescript
import { ActionPanel, Action } from "@raycast/api";

<ActionPanel>
  <ActionPanel.Section title="Primary Actions">
    <Action.CopyToClipboard content="Text to copy" />
    <Action.OpenInBrowser url="https://example.com" />
  </ActionPanel.Section>
  <ActionPanel.Section title="Secondary Actions">
    <Action.Push title="Show Details" target={<DetailView />} />
  </ActionPanel.Section>
</ActionPanel>
```

### Common Actions

#### Action.CopyToClipboard

```typescript
<Action.CopyToClipboard
  content="Text to copy"
  title="Copy to Clipboard"
  shortcut={{ modifiers: ["cmd"], key: "c" }}
/>
```

#### Action.OpenInBrowser

```typescript
<Action.OpenInBrowser
  url="https://example.com"
  title="Open in Browser"
  shortcut={{ modifiers: ["cmd"], key: "o" }}
/>
```

#### Action.Push

Navigate to a new screen:

```typescript
<Action.Push
  title="Show Details"
  target={<DetailView item={item} />}
  shortcut={{ modifiers: ["cmd"], key: "d" }}
/>
```

#### Action.SubmitForm

```typescript
<Action.SubmitForm
  title="Submit"
  onSubmit={(values) => console.log(values)}
/>
```

#### Action.ShowInFinder

```typescript
<Action.ShowInFinder path="/path/to/file" />
```

#### Action.Paste

```typescript
<Action.Paste content="Text to paste" />
```

#### Custom Action

```typescript
<Action
  title="Custom Action"
  onAction={() => console.log("Custom action triggered")}
  icon={Icon.Star}
  shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
/>
```

### Custom Keyboard Shortcuts

```typescript
const shortcuts = {
  modifiers: ["cmd", "shift"],
  key: "a"
};

<Action
  title="My Action"
  onAction={handleAction}
  shortcut={shortcuts}
/>
```

**Available modifiers**: `"cmd"`, `"ctrl"`, `"opt"`, `"shift"`

**Available keys**: Letters (a-z), numbers (0-9), special keys (`"return"`, `"delete"`, `"escape"`, `"tab"`, arrow keys, function keys, etc.)

## Icons and Colors

### Built-in Icons

```typescript
import { Icon } from "@raycast/api";

Icon.Checkmark
Icon.Circle
Icon.Star
Icon.Heart
Icon.Trash
Icon.Pencil
Icon.Plus
Icon.Minus
Icon.ExclamationMark
Icon.QuestionMark
// ... and many more
```

### Colors

```typescript
import { Color } from "@raycast/api";

Color.Red
Color.Orange
Color.Yellow
Color.Green
Color.Blue
Color.Purple
Color.Magenta
Color.PrimaryText
Color.SecondaryText
```

### Custom Images

```typescript
// Local file
const icon = { source: "icon.png" };

// URL
const icon = { source: "https://example.com/icon.png" };

// With tint color
const icon = {
  source: Icon.Circle,
  tintColor: Color.Red
};
```

## Best Practices

1. **Use appropriate components**: List for data, Grid for visual content, Detail for information, Form for input
2. **Provide search**: Add search functionality to List and Grid when you have many items
3. **Use sections**: Group related items in sections for better organization
4. **Add keyboard shortcuts**: Make common actions easily accessible via shortcuts
5. **Show loading states**: Use `isLoading` prop during async operations
6. **Use accessories wisely**: Don't overcrowd items with too many accessories
7. **Provide feedback**: Use Toast, Alert, or HUD to confirm user actions
