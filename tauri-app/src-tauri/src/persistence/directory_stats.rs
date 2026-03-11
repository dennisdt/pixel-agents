use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const STATS_FILE_DIR: &str = ".pixel-agents";
const STATS_FILE_NAME: &str = "directory-stats.json";

fn get_stats_file_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(STATS_FILE_DIR).join(STATS_FILE_NAME)
}

pub fn load_directory_stats() -> HashMap<String, u64> {
    let file_path = get_stats_file_path();
    if !file_path.exists() {
        return HashMap::new();
    }
    let raw = match fs::read_to_string(&file_path) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_directory_stats(stats: &HashMap<String, u64>) -> Result<(), String> {
    let file_path = get_stats_file_path();
    let dir = file_path.parent().unwrap();

    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(stats)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let tmp_path = file_path.with_extension("json.tmp");
    fs::write(&tmp_path, &json).map_err(|e| format!("Failed to write tmp: {}", e))?;
    fs::rename(&tmp_path, &file_path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(())
}
