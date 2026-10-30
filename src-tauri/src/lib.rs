#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Stands in for the web Notification API, which the desktop webviews don't have.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // Closing the window keeps the app running, like other Mac apps, so finished chats still notify.
    #[cfg(target_os = "macos")]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Clicking the Dock icon brings the closed window back.
    #[cfg(target_os = "macos")]
    app.run(|app, event| {
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    #[cfg(not(target_os = "macos"))]
    app.run(|_, _| {});
}
