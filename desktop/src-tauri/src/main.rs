// Not build-verified in this environment (no Rust/Cargo toolchain available
// here) — see desktop/README.md. Structured against the Tauri v2 APIs as
// documented; expect to iterate once actually compiled.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // The coordinator sidecar self-elects (docs/election.md) — it's
            // safe to spawn on every launch, laptop or not; it simply joins
            // as a client if another instance already won the election.
            let shell = app.handle().shell();
            let sidecar = shell
                .sidecar("cbc-coordinator")
                .expect("cbc-coordinator sidecar binary not found — build it first, see desktop/README.md");
            let (mut rx, _child) = sidecar.spawn().expect("failed to spawn coordinator sidecar");
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => log::info!("[coordinator] {}", String::from_utf8_lossy(&line)),
                        CommandEvent::Stderr(line) => log::warn!("[coordinator] {}", String::from_utf8_lossy(&line)),
                        _ => {}
                    }
                }
            });

            let show = MenuItem::with_id(app, "show", "Open CBC LAN Share", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // Closing the window minimizes to tray instead of quitting, so the
        // coordinator sidecar (and this laptop's eligibility to hold the
        // coordinator role) keeps running in the background.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CBC LAN Share");
}
