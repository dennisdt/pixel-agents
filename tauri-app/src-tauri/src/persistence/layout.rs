use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::mpsc;

const LAYOUT_FILE_DIR: &str = ".pixel-agents";
const LAYOUT_FILE_NAME: &str = "layout.json";
const LAYOUT_FILE_POLL_INTERVAL_MS: u64 = 2000;

pub fn get_layout_file_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(LAYOUT_FILE_DIR).join(LAYOUT_FILE_NAME)
}

pub fn read_layout_from_file() -> Option<serde_json::Value> {
    let file_path = get_layout_file_path();
    if !file_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&file_path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_layout_to_file(layout: &serde_json::Value) -> Result<(), String> {
    let file_path = get_layout_file_path();
    let dir = file_path.parent().unwrap();

    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(layout)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let tmp_path = file_path.with_extension("json.tmp");
    fs::write(&tmp_path, &json).map_err(|e| format!("Failed to write tmp: {}", e))?;
    fs::rename(&tmp_path, &file_path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(())
}

pub fn migrate_and_load_layout(
    default_layout: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    // 1. Try file
    if let Some(layout) = read_layout_from_file() {
        println!("[Pixel Agents] Layout loaded from file");
        return Some(layout);
    }

    // 2. No workspace state migration in Tauri (VS Code only)

    // 3. Use bundled default
    if let Some(default) = default_layout {
        println!("[Pixel Agents] Writing bundled default layout to file");
        let _ = write_layout_to_file(default);
        return Some(default.clone());
    }

    None
}

/// Watch ~/.pixel-agents/layout.json for external changes.
/// Returns a channel receiver for layout change events and a handle to mark own writes.
pub fn watch_layout_file(
    skip_flag: Arc<AtomicBool>,
) -> Option<mpsc::UnboundedReceiver<serde_json::Value>> {
    let file_path = get_layout_file_path();
    let (tx, rx) = mpsc::unbounded_channel();

    let skip_flag_clone = skip_flag.clone();
    let file_path_clone = file_path.clone();

    // Get initial mtime
    let last_mtime = Arc::new(std::sync::Mutex::new(
        file_path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH),
    ));

    let last_mtime_check = last_mtime.clone();
    let tx_check = tx.clone();
    let skip_check = skip_flag_clone.clone();
    let fp_check = file_path_clone.clone();

    let check_for_change = move || {
        if !fp_check.exists() {
            return;
        }
        let stat = match fp_check.metadata() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mtime = stat.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let mut last = last_mtime_check.lock().unwrap();
        if mtime <= *last {
            return;
        }
        *last = mtime;

        if skip_check.swap(false, Ordering::SeqCst) {
            return;
        }

        if let Ok(raw) = fs::read_to_string(&fp_check) {
            if let Ok(layout) = serde_json::from_str::<serde_json::Value>(&raw) {
                println!("[Pixel Agents] External layout change detected");
                let _ = tx_check.send(layout);
            }
        }
    };

    // Try to set up notify watcher
    let check_notify = check_for_change.clone();
    let _watcher: Option<RecommendedWatcher> = if let Some(parent) = file_path.parent() {
        let parent_path = parent.to_path_buf();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    check_notify();
                }
            }
        })
        .ok();

        if let Some(ref mut w) = watcher {
            let _ = w.watch(&parent_path, RecursiveMode::NonRecursive);
        }
        watcher
    } else {
        None
    };

    // Polling backup
    let check_poll = check_for_change;
    tokio::spawn(async move {
        // Keep watcher alive
        let _w = _watcher;
        loop {
            tokio::time::sleep(Duration::from_millis(LAYOUT_FILE_POLL_INTERVAL_MS)).await;
            check_poll();
        }
    });

    Some(rx)
}

/// Mark that we just wrote the layout file, so the watcher should skip the next change.
pub fn mark_own_write(skip_flag: &Arc<AtomicBool>) {
    skip_flag.store(true, Ordering::SeqCst);
}

/// Get project hash dir path (same algorithm as VS Code extension)
pub fn get_project_dir_path(workspace_path: &str) -> PathBuf {
    let dir_name: String = workspace_path
        .chars()
        .map(|c| if c == ':' || c == '\\' || c == '/' { '-' } else { c })
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("projects").join(dir_name)
}
