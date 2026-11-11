#[cfg(target_os = "macos")]
use tauri::Manager;

/// The app's own icon, for when it has no bundle to take it from.
#[cfg(target_os = "macos")]
const DEFAULT_ICON: &[u8] = include_bytes!("../icons/icon.png");

/// The setting's alternative to it.
#[cfg(target_os = "macos")]
const WAIFU_ICON: &[u8] = include_bytes!("../icons/waifu.png");

/// Whether this is the app inside its bundle, which has the icon. `tauri dev` runs the bare executable,
/// and the Dock shows macOS's generic one for that.
#[cfg(target_os = "macos")]
fn is_bundled() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        exe.ancestors()
            .any(|dir| dir.extension().is_some_and(|ext| ext == "app"))
    })
}

/// Puts the icon on the Dock. Only that: the bundle's icon in Finder and Launchpad can't change while the
/// app runs, and the Dock goes back to it when the app quits, so the page sets it again at every start.
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, icon: &str) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let image: Option<&[u8]> = match icon {
        "waifu" => Some(WAIFU_ICON),
        // Without an image, the Dock shows the bundle's icon.
        "default" if is_bundled() => None,
        "default" => Some(DEFAULT_ICON),
        _ => return Err(format!("unknown app icon: {icon}")),
    };
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let image = image
            .and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)));
        // SAFETY: Passing no image is how to go back to the bundle's icon.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(image.as_deref()) };
    })
    .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Stands in for the web Notification API, which the desktop webviews don't have.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // The desktop app updates itself from the GitHub releases, then relaunches into the new version.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![set_app_icon]);
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
