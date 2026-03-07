use tauri::{command, AppHandle, Manager};

use crate::pty::manager::PtyManager;

#[command]
pub async fn write_pty(app: AppHandle, agent_id: u32, data: String) -> Result<(), String> {
    let pty_mgr = app.state::<PtyManager>();
    pty_mgr.write_pty(agent_id, &data)
}

#[command]
pub async fn resize_pty(app: AppHandle, agent_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let pty_mgr = app.state::<PtyManager>();
    pty_mgr.resize_pty(agent_id, cols, rows)
}
