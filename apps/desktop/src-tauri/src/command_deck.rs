//! A separate, unprivileged window for the local command deck. The main workspace
//! keeps its session and page until the person chooses a source destination.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::command_deck_links::{configured_target, navigation_link, panel_page};

pub const LABEL: &str = "command-deck";

fn source_target(app: &AppHandle, url: &Url) -> Option<Url> {
    let servers = crate::servers::get(app).servers;
    if url.scheme() == "agenteschat" {
        navigation_link(url, &servers)
    } else {
        configured_target(url.as_str(), &servers)
    }
}

fn show_source(app: AppHandle, url: Url) {
    // Never print a source URL or launch ticket. Only the existing app navigator
    // may open a configured server; there is no browser fallback on failure.
    std::thread::spawn(move || {
        let _ = crate::main_window::show_url(&app, url);
    });
}

pub fn open(app: &AppHandle, url: Url) -> Result<(), String> {
    if !panel_page(&url) {
        return Err("not a command deck page".into());
    }
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
            .navigate(url)
            .map_err(|_| "command deck navigation failed")?;
        window
    } else {
        let on_navigation = app.clone();
        let on_new_window = app.clone();
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
            .title("James Command Deck")
            .inner_size(1100.0, 780.0)
            .min_inner_size(760.0, 540.0)
            .prevent_overflow()
            .disable_drag_drop_handler()
            // No capabilities file, runtime capability or initialization script
            // is added for this label. The page only has its own loopback HTTP API.
            .on_navigation(move |url| {
                if panel_page(url) {
                    return true;
                }
                if let Some(target) = source_target(&on_navigation, url) {
                    show_source(on_navigation.clone(), target);
                }
                false
            })
            .on_new_window(move |url, _| {
                if panel_page(&url) {
                    let app = on_new_window.clone();
                    std::thread::spawn(move || {
                        let _ = open(&app, url);
                    });
                } else if let Some(target) = source_target(&on_new_window, &url) {
                    show_source(on_new_window.clone(), target);
                }
                NewWindowResponse::Deny
            })
            .build()
            .map_err(|_| "command deck window could not be opened")?
    };
    let _ = window.unminimize();
    window
        .show()
        .map_err(|_| "command deck window could not be shown")?;
    crate::sync_dock(app);
    window
        .set_focus()
        .map_err(|_| "command deck window could not be focused".to_string())
}
