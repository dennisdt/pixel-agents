use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const SETTINGS_DIR: &str = ".pixel-agents";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSeatInfo {
    pub palette: u32,
    #[serde(default)]
    pub hue_shift: f64,
    pub seat_id: Option<String>,
}

fn settings_file_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(SETTINGS_DIR).join(SETTINGS_FILE)
}

fn agent_seats_file_path(project_hash: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(SETTINGS_DIR)
        .join("projects")
        .join(project_hash)
        .join("agents.json")
}

pub fn load_settings() -> AppSettings {
    let path = settings_file_path();
    if !path.exists() {
        return AppSettings { sound_enabled: true };
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(AppSettings { sound_enabled: true })
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_file_path();
    let dir = path.parent().unwrap();
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

#[allow(dead_code)]
pub fn load_agent_seats(project_hash: &str) -> HashMap<String, AgentSeatInfo> {
    let path = agent_seats_file_path(project_hash);
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_agent_seats(
    project_hash: &str,
    seats: &HashMap<String, AgentSeatInfo>,
) -> Result<(), String> {
    let path = agent_seats_file_path(project_hash);
    let dir = path.parent().unwrap();
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let json =
        serde_json::to_string_pretty(seats).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}
