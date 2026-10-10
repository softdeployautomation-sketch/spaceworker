import { homedir } from "os";
import path from "path";

// TASK_201 S7 — the ONE place that decides where the desktop EXE keeps its
// per-machine files. Extracted from lib/license-state.ts (byte-identical
// behaviour, including the tmp fallback) so the mailer EXE's embedded local
// database (lib/local-exe-db.ts) and drain settings (lib/local-exe-drain.ts)
// live beside the licensing state instead of inventing a second convention.
//
// Honours an explicit SPACEWORKER_LOCAL_DATA_DIR override (the Tauri shell can
// point at its own app-data dir), otherwise falls back to a per-OS app-data
// location — all writable by a normal user, never inside Program Files.
export function exeDataDir(): string {
  const override = process.env.SPACEWORKER_LOCAL_DATA_DIR;
  if (override) return override;

  const sys = process.platform; // win32 | darwin | linux | ...
  try {
    if (sys === "win32") {
      return path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "SpaceWorkerOS",
      );
    }
    if (sys === "darwin") {
      return path.join(
        homedir(),
        "Library",
        "Application Support",
        "SpaceWorkerOS",
      );
    }
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "spaceworker-os");
  } catch {
    return path.join(process.env.TMPDIR ?? "/tmp", "spaceworker-os");
  }
}
