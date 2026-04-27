import { execFile } from "child_process";
import { promisify } from "util";
import { dirname, join } from "path";
import { showToast, Toast } from "@raycast/api";

const execFileP = promisify(execFile);

/**
 * Run the two-step Safari sync: refresh the cached SafariTabs.db, then
 * reconcile the bookmark-index DB from that cache. Mirrors what a user runs
 * manually via `safari-sync && bookmark-index update`.
 *
 * `safari-sync` is assumed to live alongside `bookmark-index` (the standard
 * `make install` layout) so we derive its path from the configured
 * `binaryPath`.
 */
export async function syncSafari(bookmarkIndexPath: string): Promise<void> {
  const safariSyncPath = join(dirname(bookmarkIndexPath), "safari-sync");

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Syncing Safari...",
    message: "Refreshing cache",
  });

  try {
    await execFileP(safariSyncPath, []);
    toast.message = "Updating index";
    await execFileP(bookmarkIndexPath, ["update"]);
    toast.style = Toast.Style.Success;
    toast.title = "Sync complete";
    toast.message = undefined;
  } catch (err) {
    toast.style = Toast.Style.Failure;
    toast.title = "Sync failed";
    toast.message = err instanceof Error ? err.message : String(err);
    throw err;
  }
}
