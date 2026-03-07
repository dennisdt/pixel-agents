mod assets;
mod commands;
mod parser;
mod persistence;
mod pty;
mod state;
mod watcher;

use commands::{agent, assets as asset_cmds, dialog, layout, settings, terminal};
use pty::manager::PtyManager;
use state::app_state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .manage(PtyManager::new())
        .manage(agent::WatcherState::new())
        .invoke_handler(tauri::generate_handler![
            // Agent lifecycle
            agent::create_agent,
            agent::close_agent,
            agent::focus_agent,
            // Layout
            layout::save_layout,
            layout::export_layout,
            layout::import_layout,
            // Settings
            settings::app_ready,
            settings::save_agent_seats,
            settings::set_sound_enabled,
            // Terminal
            terminal::write_pty,
            terminal::resize_pty,
            // Assets
            asset_cmds::load_assets,
            // Dialog
            dialog::open_sessions_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
