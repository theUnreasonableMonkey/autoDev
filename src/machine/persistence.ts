import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { type Snapshot } from "xstate";

const STATE_FILE = "state.json";
const STATE_FILE_TMP = "state.json.tmp";

export function persistSnapshot(snapshot: Snapshot<unknown>): void {
  const data = JSON.stringify(snapshot, null, 2);
  // Atomic write: write to temp file, then rename
  writeFileSync(STATE_FILE_TMP, data, "utf-8");
  renameSync(STATE_FILE_TMP, STATE_FILE);
}

export function loadSnapshot(): Snapshot<unknown> | null {
  if (!existsSync(STATE_FILE)) {
    return null;
  }

  try {
    const data = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(data) as Snapshot<unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Failed to load state file: ${message}`);
    console.warn("Starting fresh.");
    return null;
  }
}

export function clearSnapshot(): boolean {
  if (!existsSync(STATE_FILE)) {
    return false;
  }
  unlinkSync(STATE_FILE);
  return true;
}

export function hasSnapshot(): boolean {
  return existsSync(STATE_FILE);
}
