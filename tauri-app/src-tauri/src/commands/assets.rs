use tauri::command;

#[command]
pub async fn load_assets() -> Result<(), String> {
    // Assets are loaded during app_ready — this is a no-op placeholder
    Ok(())
}
