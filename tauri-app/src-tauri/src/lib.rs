mod assets;
mod commands;
mod persistence;
mod state;
mod tty;
mod watcher;

use std::sync::atomic::Ordering;

use tauri::Manager;

use commands::{agent, assets as asset_cmds, dialog, layout, settings};
use persistence::directory_stats;
use state::app_state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Agent lifecycle
            agent::create_agent,
            agent::close_agent,
            agent::focus_agent,
            agent::list_recent_projects,
            agent::browse_for_folder,
            // Layout
            layout::save_layout,
            layout::export_layout,
            layout::import_layout,
            // Settings
            settings::app_ready,
            settings::save_agent_seats,
            settings::set_sound_enabled,
            // Assets
            asset_cmds::load_assets,
            // Dialog
            dialog::open_sessions_folder,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                if state.directory_stats_dirty.load(Ordering::SeqCst) {
                    let snapshot = state.directory_stats.lock().unwrap().clone();
                    let _ = directory_stats::save_directory_stats(&snapshot);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
