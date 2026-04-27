/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** OpenRouter API Key - Your OpenRouter API key for LLM-based URL matching */
  "openrouterApiKey": string,
  /** bookmark-index Path - Path to the bookmark-index binary */
  "binaryPath": string,
  /** Verbose Logging - Enable verbose logging to bookmark-index.log (next to bookmarks.db) */
  "verboseLogging": boolean,
  /** Skip Cache - Always skip the match cache and force a fresh LLM match */
  "noCache": boolean,
  /** Langfuse Secret Key - Langfuse secret key for observability. Leave blank to disable. */
  "langfuseSecretKey"?: string,
  /** Langfuse Public Key - Langfuse public key for observability. Leave blank to disable. */
  "langfusePublicKey"?: string,
  /** Langfuse Base URL - Langfuse API base URL. Leave blank to disable. */
  "langfuseBaseUrl"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `match-url` command */
  export type MatchUrl = ExtensionPreferences & {}
  /** Preferences accessible in the `show-tab-group` command */
  export type ShowTabGroup = ExtensionPreferences & {}
  /** Preferences accessible in the `sync-tab-groups` command */
  export type SyncTabGroups = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `match-url` command */
  export type MatchUrl = {
  /** Hint (optional) */
  "hint": string
}
  /** Arguments passed to the `show-tab-group` command */
  export type ShowTabGroup = {}
  /** Arguments passed to the `sync-tab-groups` command */
  export type SyncTabGroups = {}
}

