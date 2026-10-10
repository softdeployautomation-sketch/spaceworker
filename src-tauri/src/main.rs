// Prevents an extra console window on Windows in release builds, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// SpaceWorker OS — Tauri application shell (Task 27 Part A). Desktop binary.
//
// This slice wires the *production* packaging the plan promised: the window no
// longer depends on a separately-running dev server. The Next.js dashboard is
// built to `output:"standalone"` and packed into the EXE as the bundled local
// runtime (a real Node binary + the standalone server tree under
// `runtime/standalone`, see scripts/runtime-assemble.mjs). At launch this shell
// spawns that runtime, waits for it to listen, and points the window at it.
//
//   dev (tauri dev / debug_assertions): window loads `devUrl` directly — the
//       `next dev` server started by beforeDevCommand (scripts/run-exe-dev.sh).
//   prod (tauri build / release):      spawns `runtime/node server.js`, waits for
//       http://127.0.0.1:<LOCAL_PORT>, then navigates the main window there.
//
// Env for the local runtime mirrors scripts/run-exe-dev.sh exactly:
// SPACEWORKER_LOCAL_EXE=true (embedded in the runtime's .env.local by the
// assembler), BUILD_TARGET=extractor, and the license secret baked in so the
// EXE is licensable with zero external secrets. The child is killed when the
// window closes.

use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{Manager, Url};

/// Dedicated loopback port the bundled Next.js runtime serves the dashboard on.
const LOCAL_PORT: u16 = 34413;

/// TASK_183 — devices-wrapper entry: the HOSTED app route that sets the
/// `sw_wrapper` scoping cookie and 307s to /dashboard/devices. The wrapper is a
/// window onto the hosted app (owner: "it just connects to our app") — it runs
/// NO local runtime, so session/wallet/devices/all data ride the hosted backend
/// and there is no local 24h license to show. The extractor/local-runtime builds
/// keep their bundled runtime and never see this constant.
const WRAPPER_ENTRY_URL: &str = "https://spaceworker.top/wrapper/devices";

/// TASK_183 — identifier set ONLY by src-tauri/tauri.devices.conf.json (merged
/// over tauri.conf.json's `com.spaceworker-os.desktop` via build-exe.yml's
/// `--config`; the extractor variant has its own `...extractor`). Fail-closed:
/// anything else keeps the local-runtime behavior below, byte-identical.
const WRAPPER_IDENTIFIER: &str = "com.spaceworker-os.devices";

/// TASK_201 — mailer identifier, set ONLY by src-tauri/tauri.mailer.conf.json
/// (same `--config` merge as the wrapper/extractor). Used to pick the mailer's
/// landing route below so the window opens on Campaigns, not the extractor's
/// Extract screen. Fail-closed: any other identifier keeps /dashboard/extract.
const MAILER_IDENTIFIER: &str = "com.spaceworker-os.mailer";

/// The first dashboard route the window navigates to once the bundled runtime
/// answers. Per build target so each EXE lands on its own primary screen:
/// the mailer opens on Campaigns (its nav is Campaigns + Settings only), the
/// extractor (and the default) opens on Extract — byte-identical to the
/// pre-TASK_201 behavior. Owner (2026-10): the mailer landing on the
/// extractor's Extract page was a live bug — BUILD_TARGET=mailer was correct
/// everywhere, but this hardcoded route ignored it.
fn landing_route(identifier: &str) -> &'static str {
    if identifier == MAILER_IDENTIFIER {
        "/dashboard/campaigns"
    } else {
        "/dashboard/extract"
    }
}

/// The spawned local-runtime child process — killed when the window closes.
struct LocalRuntime(Mutex<Option<Child>>);

/// Platform-appropriate name for the bundled Node binary (see runtime-assemble.mjs).
fn node_name() -> String {
    let mut name = String::from("node");
    if cfg!(target_os = "windows") {
        name.push_str(".exe");
    }
    name
}

fn find_runtime_dir(resource_dir: &Path) -> Option<std::path::PathBuf> {
    // Tauri v2 stages `bundle.resources` into the per-OS resource root, but the
    // exact layout varies by platform/packager (e.g. a `../exe/runtime` source
    // can land at `_up_/exe/runtime` on macOS, `exe/runtime` elsewhere). Locate
    // it by probing for the marker file instead of betting on one layout.
    let candidates = [
        resource_dir.join("runtime"),
        resource_dir.join("exe").join("runtime"),
        resource_dir.join("_up_").join("runtime"),
        resource_dir.join("_up_").join("exe").join("runtime"),
    ];
    candidates
        .into_iter()
        .find(|c| c.join("standalone").join("server.js").exists())
}

/// Spawns the bundled Next.js standalone server with the bundled Node runtime.
fn spawn_local_runtime(resource_dir: &Path) -> Option<Child> {
    let runtime_dir = find_runtime_dir(resource_dir)?;
    let node = runtime_dir.join(node_name());
    let standalone = runtime_dir.join("standalone");
    if !node.exists() || !standalone.join("server.js").exists() {
        eprintln!(
            "SpaceWorker OS: bundled runtime missing (expected {} and {})",
            node.display(),
            standalone.join("server.js").display()
        );
        return None;
    }

    let mut cmd = Command::new(&node);
    cmd.arg("server.js")
        .current_dir(&standalone)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", LOCAL_PORT.to_string())
        .env("NODE_ENV", "production");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no extra console window
    }

    cmd.spawn().ok()
}

/// Polls until the runtime is accepting connections on LOCAL_PORT.
fn wait_for_runtime(period: Duration, attempts: u32) -> bool {
    for _ in 0..attempts {
        if TcpStream::connect(("127.0.0.1", LOCAL_PORT)).is_ok() {
            return true;
        }
        thread::sleep(period);
    }
    false
}

fn main() {
    tauri::Builder::default()
        // Task 57 Bug 2 — native "Save As" for the EXE's Export CSV (WebView2
        // swallows the browser download; plugin-dialog picks the path, plugin-fs
        // writes it).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(LocalRuntime(Mutex::new(None)))
        .setup(|app| {
            if !cfg!(debug_assertions) {
                // TASK_183 — devices wrapper: point the window straight at the
                // HOSTED app entry route and do NOT spawn the bundled runtime.
                // The local runtime ships with no DATABASE_URL/SESSION_SECRET
                // and has no forwarding to hosted, so it could never serve the
                // device list, wallet or session — the 24h license gate was the
                // first wall, broken data was every wall after it. Navigation
                // is immediate (the window shows the splash until first paint);
                // no wait-for-runtime loop applies here.
                if app.config().identifier == WRAPPER_IDENTIFIER {
                    let win = app
                        .get_webview_window("main")
                        .expect("main window missing");
                    if let Ok(url) = Url::parse(WRAPPER_ENTRY_URL) {
                        let _ = win.navigate(url);
                    }
                    return Ok(());
                }
                // Production: spawn the bundled runtime, then point the window at
                // it once it answers. Doing the wait on a background thread keeps
                // setup snappy — the window shows the splash placeholder meanwhile.
                let res_dir = app.path().resource_dir().expect("resource dir missing");
                let child = spawn_local_runtime(&res_dir);
                *app.state::<LocalRuntime>().0.lock().unwrap() = child;

                let win = app
                    .get_webview_window("main")
                    .expect("main window missing");
                // TASK_201 — land on the build's own primary screen. Read the
                // identifier once here (before the thread takes ownership of
                // `win`) and move the resolved &'static route into the closure.
                let route = landing_route(app.config().identifier.as_str());
                thread::spawn(move || {
                    if wait_for_runtime(Duration::from_millis(300), 150) {
                        let url = Url::parse(&format!(
                            "http://127.0.0.1:{}{}",
                            LOCAL_PORT, route
                        ))
                        .expect("invalid local url");
                        let _ = win.navigate(url);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window.state::<LocalRuntime>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run SpaceWorker OS");
}