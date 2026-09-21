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
                // Production: spawn the bundled runtime, then point the window at
                // it once it answers. Doing the wait on a background thread keeps
                // setup snappy — the window shows the splash placeholder meanwhile.
                let res_dir = app.path().resource_dir().expect("resource dir missing");
                let child = spawn_local_runtime(&res_dir);
                *app.state::<LocalRuntime>().0.lock().unwrap() = child;

                let win = app
                    .get_webview_window("main")
                    .expect("main window missing");
                thread::spawn(move || {
                    if wait_for_runtime(Duration::from_millis(300), 150) {
                        let url = Url::parse(&format!(
                            "http://127.0.0.1:{}/dashboard/extract",
                            LOCAL_PORT
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