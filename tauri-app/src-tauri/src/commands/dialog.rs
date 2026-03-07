use std::path::PathBuf;
use tauri::command;

#[command]
pub async fn open_sessions_folder() -> Result<(), String> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let sessions_dir = home.join(".claude").join("projects");
    if sessions_dir.exists() {
        open::that(&sessions_dir).map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}
