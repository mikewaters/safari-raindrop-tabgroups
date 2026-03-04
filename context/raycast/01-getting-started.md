# Getting Started with Raycast Extensions

## Overview

Raycast extensions allow you to build rich, interactive applications with dedicated UIs using React, TypeScript, and Node.js. Extensions are rendered natively in Raycast with a strongly-typed API, hot-reloading, and modern tooling.

## Technology Stack

- **React**: For UI declaration with functional components and hooks
- **TypeScript**: Fully-typed API for compile-time error checking
- **Node.js**: Access to npm ecosystem for dependencies
- **Native Rendering**: React components are rendered to native macOS UI (not DOM-based)

## Prerequisites

- macOS (Windows support available for most extensions)
- Raycast installed
- Node.js and npm installed

## Creating Your First Extension

### Method 1: Using the "Create Extension" Command

1. **Open Raycast** and search for "Create Extension"
2. **Name your extension** and select a template:
   - **Detail**: Shows detailed information view
   - **List**: Shows a list of items
   - **Form**: Creates forms for user input
   - **Hello World**: Basic starter template
3. **Select parent folder** where you want to create the extension
4. **Press ⌘ ↵** to create the extension

### Method 2: Using the CLI

```bash
# Navigate to your development folder
cd ~/Development

# Use npx to create a new extension
npx ray develop
```

## Project Structure

A newly created extension has the following structure:

```
my-extension/
├── .eslintrc.json          # ESLint configuration with recommended rules
├── .prettierrc             # Prettier code formatting config
├── assets/
│   └── icon.png           # Extension icon (512x512px recommended)
├── node_modules/          # Dependencies
├── package.json           # Extension manifest and metadata
├── package-lock.json      # Locked dependency versions
├── src/
│   └── index.tsx          # Main command file (or multiple command files)
├── tsconfig.json          # TypeScript configuration
└── README.md              # Extension documentation
```

### Key Files

#### package.json

This is the extension manifest containing:
- Extension metadata (title, description, author)
- Commands configuration
- Dependencies
- Build scripts

Example:
```json
{
  "name": "my-extension",
  "title": "My Extension",
  "description": "A helpful extension",
  "commands": [
    {
      "name": "index",
      "title": "Main Command",
      "description": "Main command description",
      "mode": "view"
    }
  ],
  "dependencies": {
    "@raycast/api": "^1.70.0"
  },
  "scripts": {
    "dev": "ray develop",
    "build": "ray build",
    "lint": "ray lint"
  }
}
```

#### tsconfig.json

Configures TypeScript compilation. The default configuration is optimized for Raycast extensions.

#### src/ folder

All source files go in the `src` folder:
- Use `.tsx` or `.jsx` for commands with UI
- Use `.ts` or `.js` for scripts without UI
- TypeScript is strongly recommended for type safety

## Installation & Setup

### 1. Create Extension

```bash
# Using Raycast UI (recommended)
Open Raycast → "Create Extension" → Follow prompts

# Or using CLI
npx ray create my-extension
```

### 2. Install Dependencies

```bash
cd my-extension
npm install
```

### 3. Start Development Mode

```bash
npm run dev
```

This command:
- Starts development mode with hot-reloading
- Watches for file changes
- Displays errors and logs in terminal
- Makes extension available in Raycast

### 4. Test in Raycast

1. Open Raycast (⌘ Space)
2. Your extension appears at the top of root search
3. Select it to run
4. Make changes in code and save - extension reloads automatically

## Development Workflow

### Hot Reloading

Raycast watches your source files and automatically:
1. Transpiles TypeScript to JavaScript
2. Bundles the extension
3. Reloads it in Raycast
4. Shows any errors in terminal

**Toggle auto-reload**: Raycast Preferences → Advanced → "Auto-reload on save"

### Development Commands

```bash
# Start development mode (hot reload)
npm run dev

# Build for production
npm run build

# Lint code
npm run lint

# Fix linting issues
npm run fix-lint
```

### Console Logging

During development, all console logs appear in the terminal:

```typescript
console.log("Debug info:", data);
console.error("Error occurred:", error);
console.warn("Warning:", warning);
```

## Your First Extension Code

### Simple List Example

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item title="Item 1" subtitle="Description 1" />
      <List.Item title="Item 2" subtitle="Description 2" />
      <List.Item title="Item 3" subtitle="Description 3" />
    </List>
  );
}
```

### List with State and Actions

```typescript
import { List, ActionPanel, Action } from "@raycast/api";
import { useState } from "react";

export default function Command() {
  const [items, setItems] = useState([
    { id: 1, title: "Item 1" },
    { id: 2, title: "Item 2" },
  ]);

  return (
    <List>
      {items.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard content={item.title} />
              <Action.OpenInBrowser url="https://example.com" />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

## Next Steps

1. **Explore UI Components** - See `02-ui-components.md` for all available components
2. **Learn the API** - See `03-api-reference.md` for hooks, utilities, and APIs
3. **Study Examples** - See `04-code-examples.md` for complete working examples
4. **Follow Best Practices** - See `05-best-practices.md` for guidelines
5. **Browse Extensions** - Visit [Raycast Store](https://www.raycast.com/store) for inspiration

## Key Concepts

### Commands

Each extension can have multiple commands. Commands are the entry points users invoke from Raycast.

### Views

Commands render one of these view types:
- **List**: For multiple similar items
- **Grid**: For visual items with images
- **Detail**: For detailed information
- **Form**: For user input

### Actions

User interactions are handled through ActionPanels containing Actions. Common actions:
- Copy to clipboard
- Open URL in browser
- Push new view
- Show toast notification

## Troubleshooting

### Extension Not Appearing

1. Check terminal for build errors
2. Verify `npm run dev` is running
3. Restart Raycast (⌘ Q and reopen)

### Type Errors

1. Ensure `@raycast/api` version matches
2. Run `npm install` to update dependencies
3. Check `tsconfig.json` is properly configured

### Hot Reload Not Working

1. Check Preferences → Advanced → "Auto-reload on save"
2. Manually reload with ⌘ R in Raycast
3. Restart development server

## Resources

- **Official Documentation**: https://developers.raycast.com
- **API Reference**: https://developers.raycast.com/api-reference
- **Examples Repository**: https://github.com/raycast/extensions
- **Community**: https://raycast.com/community
