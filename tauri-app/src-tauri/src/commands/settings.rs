use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{command, AppHandle, Emitter, Manager};

use crate::assets::loader;
use crate::persistence::{layout, settings};
use crate::state::app_state::AppState;
use crate::watcher::global_scanner;

#[command]
pub async fn app_ready(app: AppHandle) -> Result<(), String> {
    println!("[Pixel Agents] app_ready called");
    let state = app.state::<AppState>();

    // Determine assets root from the resource path
    let assets_root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    println!("[Pixel Agents] assets_root: {:?}", assets_root);

    *state.assets_root.lock().unwrap() = Some(assets_root.clone());

    // 1. Character sprites
    if let Some(characters) = loader::load_character_sprites(&assets_root) {
        println!("[Pixel Agents] Loaded {} character sprites", characters.len());
        let _ = app.emit("backend-event", serde_json::json!({
            "type": "characterSpritesLoaded",
            "characters": characters,
        }));
    } else {
        println!("[Pixel Agents] No character sprites found");
    }

    // 2. Floor tiles
    if let Some(sprites) = loader::load_floor_tiles(&assets_root) {
        println!("[Pixel Agents] Loaded {} floor tiles", sprites.len());
        let _ = app.emit("backend-event", serde_json::json!({
            "type": "floorTilesLoaded",
            "sprites": sprites,
        }));
    } else {
        println!("[Pixel Agents] No floor tiles found");
    }

    // 3. Wall tiles
    if let Some(sprites) = loader::load_wall_tiles(&assets_root) {
        println!("[Pixel Agents] Loaded {} wall tiles", sprites.len());
        let _ = app.emit("backend-event", serde_json::json!({
            "type": "wallTilesLoaded",
            "sprites": sprites,
        }));
    } else {
        println!("[Pixel Agents] No wall tiles found");
    }

    // 4. Furniture assets
    if let Some((catalog, sprites)) = loader::load_furniture_assets(&assets_root) {
        println!("[Pixel Agents] Loaded {} furniture assets", catalog.len());
        let _ = app.emit("backend-event", serde_json::json!({
            "type": "furnitureAssetsLoaded",
            "catalog": catalog,
            "sprites": sprites,
        }));
    } else {
        println!("[Pixel Agents] No furniture assets found");
    }

    // 5. Layout
    let default_layout = loader::load_default_layout(&assets_root);
    println!("[Pixel Agents] Default layout: {}", if default_layout.is_some() { "found" } else { "not found" });
    let layout_data = layout::migrate_and_load_layout(default_layout.as_ref());
    println!("[Pixel Agents] Layout data: {}", if layout_data.is_some() { "loaded" } else { "none" });
    let _ = app.emit("backend-event", serde_json::json!({
        "type": "layoutLoaded",
        "layout": layout_data,
    }));
    println!("[Pixel Agents] Emitted layoutLoaded");

    // 6. Settings
    let app_settings = settings::load_settings();
    let _ = app.emit("backend-event", serde_json::json!({
        "type": "settingsLoaded",
        "soundEnabled": app_settings.sound_enabled,
    }));

    // 7. Start layout file watcher
    let skip_flag = state.layout_skip_flag.clone();
    if let Some(mut rx) = layout::watch_layout_file(skip_flag) {
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(layout_val) = rx.recv().await {
                let _ = app_clone.emit("backend-event", serde_json::json!({
                    "type": "layoutLoaded",
                    "layout": layout_val,
                }));
            }
        });
    }

    // 8. Start global session scanner (discovers Claude sessions via TTY)
    {
        let mut scan_handle = state.global_scan_handle.lock().unwrap();
        if scan_handle.is_none() {
            let handle = global_scanner::start_global_scan(
                state.known_pids.clone(),
                state.agents.clone(),
                state.next_agent_id.clone(),
                state.next_terminal_index.clone(),
                app.clone(),
            );
            *scan_handle = Some(handle);
        }
    }

    // 9. Emit existing agents for webview reload (skip spawn animation)
    {
        let lock = state.agents.lock().unwrap();
        let existing: Vec<_> = lock.values().map(|a| {
            serde_json::json!({
                "id": a.id,
                "isExternal": a.is_external,
                "folderName": a.folder_name,
            })
        }).collect();
        if !existing.is_empty() {
            let _ = app.emit("backend-event", serde_json::json!({
                "type": "existingAgents",
                "agents": existing,
            }));
        }
    }

    Ok(())
}

#[command]
pub async fn save_agent_seats(
    app: AppHandle,
    seats: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let project_hash = state.project_hash.lock().unwrap().clone();

    if let Some(hash) = project_hash {
        if let Some(obj) = seats.as_object() {
            let mut seat_map = HashMap::new();
            for (key, val) in obj {
                if let Ok(info) = serde_json::from_value::<settings::AgentSeatInfo>(val.clone()) {
                    seat_map.insert(key.clone(), info);
                }
            }
            settings::save_agent_seats(&hash, &seat_map)?;
        }
    }

    Ok(())
}

#[command]
pub async fn set_sound_enabled(enabled: bool) -> Result<(), String> {
    let mut app_settings = settings::load_settings();
    app_settings.sound_enabled = enabled;
    settings::save_settings(&app_settings)?;
    Ok(())
}
