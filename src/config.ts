import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the config file path.
 * - Compiled binary (/$bunfs): $XDG_CONFIG_HOME/safari-tabgroups/config.toml
 * - bun run (dev): CWD/fetch.config.toml
 */
export function resolveConfigPath(): string {
  const isCompiled = import.meta.dir.startsWith("/$bunfs");
  if (isCompiled) {
    const configHome =
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(configHome, "safari-tabgroups", "config.toml");
  }
  return join(process.cwd(), "fetch.config.toml");
}
