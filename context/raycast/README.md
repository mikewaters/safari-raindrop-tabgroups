# Dashboard - Raycast Extension Research & Documentation

Complete research and documentation for building a Raycast extension with dedicated UI views.

## Overview

This repository contains comprehensive documentation for developing Raycast extensions, with a specific focus on creating extensions with dedicated user interfaces. Raycast extensions are built using React, TypeScript, and Node.js, with native UI rendering for fast, consistent experiences.

## What is Raycast?

Raycast is a blazingly fast, extensible launcher for macOS (and Windows) that allows developers to build custom extensions with rich, interactive UIs. Extensions can integrate with APIs, manage data, and provide powerful workflows - all accessible via a simple keyboard shortcut.

## Project Structure

This documentation is organized into 6 comprehensive guides:

### 📚 Documentation Files

1. **[01-getting-started.md](./01-getting-started.md)** - Setup, Installation & First Extension
   - Technology stack overview
   - Creating your first extension
   - Project structure and file organization
   - Development workflow
   - Initial code examples

2. **[02-ui-components.md](./02-ui-components.md)** - Complete UI Components Reference
   - List component (for data collections)
   - Grid component (for visual content)
   - Detail component (for detailed information)
   - Form component (for user input)
   - ActionPanel & Actions
   - Icons, Colors, and styling

3. **[03-api-reference.md](./03-api-reference.md)** - APIs, Hooks & Utilities
   - React Hooks (useState, useEffect, custom hooks)
   - Raycast-specific hooks (usePromise, useFetch, useCachedState)
   - Storage & LocalStorage
   - Preferences API
   - Navigation
   - Feedback components (Toast, Alert, HUD)
   - System utilities (Clipboard, Environment, File operations)

4. **[04-code-examples.md](./04-code-examples.md)** - Complete Working Examples
   - Todo List application
   - GitHub Repository Search
   - Hacker News Reader
   - Note-taking app with Forms
   - Image Grid Browser
   - API integration with authentication
   - Real-world patterns and implementations

5. **[05-best-practices.md](./05-best-practices.md)** - Development Guidelines
   - Project organization
   - TypeScript best practices
   - Performance optimization
   - User experience guidelines
   - Error handling
   - Navigation patterns
   - Security considerations
   - Testing & debugging
   - Extension store guidelines

6. **[06-resources.md](./06-resources.md)** - Links & References
   - Official documentation links
   - API reference URLs
   - Community tutorials
   - GitHub repositories
   - Developer tools
   - Learning path
   - Quick reference cheat sheet

## Quick Start

### For Developers New to Raycast

1. **Start here**: Read [01-getting-started.md](./01-getting-started.md)
2. **Learn UI**: Study [02-ui-components.md](./02-ui-components.md)
3. **Build something**: Follow examples in [04-code-examples.md](./04-code-examples.md)
4. **Refine your skills**: Apply [05-best-practices.md](./05-best-practices.md)

### For Experienced Developers

1. **Quick reference**: Use [06-resources.md](./06-resources.md) for links
2. **API docs**: Reference [03-api-reference.md](./03-api-reference.md)
3. **Patterns**: Copy from [04-code-examples.md](./04-code-examples.md)
4. **Polish**: Follow [05-best-practices.md](./05-best-practices.md)

## Key Concepts

### Dedicated UI Views

Raycast supports several dedicated UI view types:

- **List**: Display collections of items with search, filtering, and accessories
- **Grid**: Show visual content in a grid layout with images
- **Detail**: Present detailed information with markdown and metadata
- **Form**: Collect user input with various form fields

### Navigation

Extensions can have multiple screens using the Navigation API:
- Push new views onto the stack
- Pop back to previous screens
- Maintain navigation breadcrumbs

### Actions

User interactions are handled through ActionPanels containing Actions:
- Built-in actions (Copy, Open in Browser, etc.)
- Custom actions with keyboard shortcuts
- Organized in sections

### Data Persistence

Multiple options for storing data:
- **LocalStorage**: Persistent key-value storage
- **useCachedState**: State that persists between runs
- **Preferences**: User-configurable settings
- **Cache**: Performance optimization

## Technology Stack

- **React**: UI declaration with functional components
- **TypeScript**: Fully-typed API for compile-time safety
- **Node.js**: Access to npm ecosystem
- **Native Rendering**: React components render to native macOS UI (not DOM-based)

## Essential Features

### Hot Reloading

Automatic reload during development - see changes instantly without restarting Raycast.

### Type Safety

Fully-typed TypeScript API catches errors at compile time.

### Rich UI Components

Native components for lists, grids, forms, and detail views.

### Powerful Hooks

React hooks for async operations, caching, storage, and more.

### System Integration

Access clipboard, files, preferences, and system utilities.

## Development Workflow

```bash
# Create extension (use Raycast UI command)
# "Create Extension" in Raycast

# Install dependencies
npm install

# Start development mode
npm run dev

# Make changes and save - extension reloads automatically

# Build for production
npm run build

# Lint code
npm run lint
```

## Example Extension Structure

```typescript
import { List, ActionPanel, Action } from "@raycast/api";
import { useState } from "react";

export default function Command() {
  const [items, setItems] = useState(["Item 1", "Item 2"]);

  return (
    <List searchBarPlaceholder="Search items...">
      {items.map((item) => (
        <List.Item
          key={item}
          title={item}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard content={item} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

## Common Use Cases

Raycast extensions are perfect for:

- **Productivity Tools**: Todo lists, note-taking, bookmarks
- **API Integrations**: Search GitHub, browse APIs, fetch data
- **System Utilities**: File management, clipboard history, calculations
- **Information Display**: News readers, weather, stocks
- **Quick Actions**: Text transformations, conversions, generators
- **Dashboard Views**: Status monitoring, analytics display

## Learning Resources

### Official Resources

- **Documentation**: https://developers.raycast.com
- **API Reference**: https://developers.raycast.com/api-reference
- **Examples**: https://developers.raycast.com/examples
- **GitHub**: https://github.com/raycast/extensions

### This Documentation

All links and resources are compiled in [06-resources.md](./06-resources.md)

## Dashboard Extension Plan

The Dashboard extension will be a Raycast extension featuring:

- **Dedicated UI**: Custom views using List, Grid, and Detail components
- **Navigation**: Multi-screen experience with push/pop navigation
- **Data Display**: Visual presentation of dashboard metrics
- **Actions**: Quick actions for common tasks
- **Preferences**: User-configurable settings

## Getting Help

1. **Read the docs**: Start with documentation files in this repo
2. **Official docs**: https://developers.raycast.com
3. **GitHub Issues**: https://github.com/raycast/extensions/issues
4. **Community**: Join Raycast Discord
5. **Examples**: Browse published extensions

## Next Steps

### To Start Building the Dashboard Extension:

1. ✅ **Research completed** - This documentation
2. 📝 **Plan features** - Define dashboard requirements
3. 🎨 **Design UI** - Sketch out screens and navigation
4. 💻 **Implement** - Build using these docs as reference
5. 🧪 **Test** - Use development mode for rapid iteration
6. 🚀 **Deploy** - Publish to Raycast Store or use privately

## Contributing

This documentation is based on:
- Official Raycast documentation
- Community tutorials and examples
- Real-world extension analysis
- Best practices from the Raycast ecosystem

## Sources

All sources and research are documented with links in [06-resources.md](./06-resources.md).

### Key Sources:

- [Raycast Developers Portal](https://developers.raycast.com)
- [Raycast API Reference](https://developers.raycast.com/api-reference)
- [GitHub Extensions Repository](https://github.com/raycast/extensions)
- [Raycast Blog](https://www.raycast.com/blog/how-raycast-api-extensions-work)
- [Community Tutorials](https://dev.to/orliesaurus/build-your-own-raycast-extension-step-by-step-tutorial-5068)

---

**Ready to build your Raycast extension?** Start with [01-getting-started.md](./01-getting-started.md)!
