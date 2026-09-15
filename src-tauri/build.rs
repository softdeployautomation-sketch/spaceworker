fn main() {
    tauri_build::build();
    // Tauri v2's build.rs applies platform resources (Windows .ico embedding via
    // winresorcer / macOS icon handling). No custom work needed for this slice.
}