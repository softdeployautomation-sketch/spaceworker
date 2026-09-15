// SpaceWorker OS — Tauri application shell (Task 27 Part A). Desktop binary.
//
// This slice is the desktop shell that hosts the real Next.js dashboard inside a
// native window (the plan's "one shared local runtime, four build targets" model).
// In dev it points the window at the running `next dev` server via `devUrl`
// (started by `beforeDevCommand` → `scripts/run-exe-dev.sh`); the shared
// `<LicenseGate>` component renders inside Next and calls the local
// `/api/exe-license/*` routes, which run offline against the embedded secret.
//
// No Rust-side commands are needed for this slice — the shell is intentionally a
// bare window. (The production packaging slice later adds a shell-plugin sidecar
// that spawns the bundled local runtime and wires reproducible dev builds.)
fn main() {
    tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to run SpaceWorker OS");
}