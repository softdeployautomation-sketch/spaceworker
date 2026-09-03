import "server-only";
import { mkdir, rm } from "fs/promises";
import { resolve, sep } from "path";

function getBaseDir(): string {
  const dir = process.env.BROWSER_PROFILE_BASE_DIR;
  if (!dir) {
    throw new Error("BROWSER_PROFILE_BASE_DIR is not set");
  }
  return dir;
}

const BASE_DIR = getBaseDir();

// Guard against path traversal. Call before any fs operation.
export function assertSafePath(dirPath: string): void {
  const normalizedBase = resolve(BASE_DIR);
  const normalized = resolve(dirPath);
  if (!normalized.startsWith(normalizedBase + sep)) {
    throw new Error("Path traversal detected");
  }
}

// Returns the canonical path for a profile ID. Does NOT create the directory.
export function profileDirPath(profileId: string): string {
  return resolve(BASE_DIR, profileId);
}

// Create the profile directory on disk. Safe — validates path first.
export async function createProfileDir(profileId: string): Promise<string> {
  const dirPath = profileDirPath(profileId);
  assertSafePath(dirPath);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

// Delete the profile directory on disk. Safe — validates path first.
// Does not throw if directory doesn't exist.
export async function deleteProfileDir(dirPath: string): Promise<void> {
  assertSafePath(dirPath);
  await rm(dirPath, { recursive: true, force: true });
}