use tauri::{command, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::persistence::layout::{mark_own_write, write_layout_to_file};
use crate::state::app_state::AppState;

#[command]
pub async fn save_layout(app: AppHandle, layout: serde_json::Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    mark_own_write(&state.layout_skip_flag);
    write_layout_to_file(&layout)?;
    Ok(())
}

#[command]
pub async fn export_layout(app: AppHandle) -> Result<(), String> {
    let layout = crate::persistence::layout::read_layout_from_file();
    let Some(layout) = layout else {
        return Err("No layout to export".into());
    };

    let json = serde_json::to_string_pretty(&layout)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    let file_path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("pixel-agents-layout.json")
        .blocking_save_file();

    if let Some(path) = file_path {
        std::fs::write(path.as_path().unwrap(), json)
            .map_err(|e| format!("Failed to write: {}", e))?;
    }

    Ok(())
}

#[command]
pub async fn import_layout(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    let file_path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    let Some(path) = file_path else {
        return Ok(()); // User cancelled
    };

    let content = std::fs::read_to_string(path.as_path().unwrap())
        .map_err(|e| format!("Failed to read: {}", e))?;
    let layout: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;

    // Validate basic structure
    if layout.get("version") != Some(&serde_json::json!(1)) {
        return Err("Invalid layout: missing version 1".into());
    }
    if !layout.get("tiles").map_or(false, |t| t.is_array()) {
        return Err("Invalid layout: missing tiles array".into());
    }

    mark_own_write(&state.layout_skip_flag);
    write_layout_to_file(&layout)?;

    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "layoutLoaded",
            "layout": layout,
        }),
    );

    Ok(())
}
