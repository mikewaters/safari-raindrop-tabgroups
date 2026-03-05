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
  "binaryPath": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `match-url` command */
  export type MatchUrl = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `match-url` command */
  export type MatchUrl = {
  /** Hint (optional) */
  "hint": string
}
}

