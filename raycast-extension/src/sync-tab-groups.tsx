import { getPreferenceValues } from "@raycast/api";
import { syncSafari } from "./sync";

interface Preferences {
  binaryPath: string;
}

export default async function Command() {
  const { binaryPath } = getPreferenceValues<Preferences>();
  try {
    await syncSafari(binaryPath);
  } catch {
    // syncSafari already shows a failure toast; swallow so Raycast doesn't
    // surface the rejection as an unhandled error.
  }
}
