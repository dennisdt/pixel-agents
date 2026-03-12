use std::io::BufRead;

use tauri::{command, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::persistence::layout::get_project_dir_path;
use crate::state::agent_state::AgentState;
use crate::state::app_state::AppState;
use crate::tty;
use crate::watcher::global_scanner;

#[command]
pub async fn create_agent(
    app: AppHandle,
    folder_path: Option<String>,
) -> Result<u32, String> {
    let state = app.state::<AppState>();

    let cwd = folder_path.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let session_id = uuid::Uuid::new_v4().to_string();
    let project_dir = get_project_dir_path(&cwd);

    let (id, terminal_index) = {
        let mut next_id = state.next_agent_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;
        let mut next_idx = state.next_terminal_index.lock().unwrap();
        let idx = *next_idx;
        *next_idx += 1;
        (id, idx)
    };

    let mut agent = AgentState::new(id, session_id.clone(), project_dir, terminal_index);
    agent.cwd = Some(cwd.clone());

    state.agents.lock().unwrap().insert(id, agent);

    // Launch Terminal.app with claude via osascript
    // Escape both single quotes (for shell) and backslashes/double quotes (for AppleScript)
    let escaped_cwd = cwd
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\'', "'\\''");
    let script = format!(
        r#"tell application "Terminal"
            activate
            do script "cd '{escaped_cwd}' && claude --session-id {session_id}"
        end tell"#,
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to launch Terminal.app: {}", e))?;

    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "agentCreated",
            "id": id,
            "cwd": cwd,
        }),
    );

    // Store project hash for seat persistence
    {
        let dir_name = tty::hash_path(std::path::Path::new(&cwd));
        *state.project_hash.lock().unwrap() = Some(dir_name);
    }

    Ok(id)
}

#[command]
pub async fn close_agent(app: AppHandle, id: u32) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Keep PID in known_pids so the scanner doesn't re-discover the process
    state.agents.lock().unwrap().remove(&id);

    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "agentClosed",
            "id": id,
        }),
    );

    Ok(())
}

#[command]
pub async fn focus_agent(app: AppHandle, id: u32) -> Result<(), String> {
    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "agentSelected",
            "id": id,
        }),
    );

    let state = app.state::<AppState>();

    // Extract what we need from the lock, then release before any blocking calls
    let (cached_tty, lookup_info) = {
        let agents = state.agents.lock().unwrap();
        match agents.get(&id) {
            Some(a) if a.tty.is_some() => (a.tty.clone(), None),
            Some(a) => {
                let project_hash = a
                    .project_dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                (None, Some((a.session_id.clone(), project_hash)))
            }
            None => (None, None),
        }
    };

    let tty = if let Some(tty) = cached_tty {
        Some(tty)
    } else if let Some((session_id, project_hash)) = lookup_info {
        let processes = tokio::task::spawn_blocking(global_scanner::get_running_claude_processes)
            .await
            .unwrap_or_default();
        processes
            .iter()
            .find(|p| {
                p.session_id.as_deref() == Some(&session_id)
                    || p.project_dir_hash == project_hash
            })
            .and_then(|p| p.tty.clone())
    } else {
        None
    };

    println!("[Pixel Agents] focus_agent {}: tty={:?}", id, tty);

    let script = if let Some(ref tty_path) = tty {
        // tty_path is from ps output (/dev/ttysNNN), escape defensively
        let escaped_tty = tty_path.replace('\\', "\\\\").replace('"', "\\\"");
        format!(
            r#"tell application "Terminal"
                activate
                repeat with w in windows
                    repeat with t in tabs of w
                        if tty of t is "{escaped_tty}" then
                            set selected tab of w to t
                            set index of w to 1
                            return
                        end if
                    end repeat
                end repeat
            end tell"#,
        )
    } else {
        r#"tell application "Terminal" to activate"#.to_string()
    };

    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn();

    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    hash: String,
    display_name: String,
    full_path: Option<String>,
    last_used: u64,
}

const MAX_RECENT_PROJECTS: usize = 5;

#[command]
pub async fn list_recent_projects() -> Result<Vec<RecentProject>, String> {
    tokio::task::spawn_blocking(list_recent_projects_blocking)
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Collect recent projects from ~/.claude/projects, sorted by last JSONL modification time.
/// Reads `cwd` from JSONL files to get the actual project path (no filesystem scanning).
fn list_recent_projects_blocking() -> Result<Vec<RecentProject>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let projects_dir = home.join(".claude/projects");

    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

    let mut candidates: Vec<(String, u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        let Some((_, last_used)) = newest_jsonl_file(&path) else {
            continue;
        };
        candidates.push((dir_name, last_used, path));
    }

    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates.truncate(MAX_RECENT_PROJECTS);

    let projects = candidates
        .into_iter()
        .map(|(dir_name, last_used, project_path)| {
            let full_path = read_cwd_from_jsonl(&project_path)
                .filter(|p| std::path::Path::new(p).exists());
            let display_name = match &full_path {
                Some(p) => display_name_from_path(p),
                None => global_scanner::fallback_folder_name(&dir_name),
            };
            RecentProject {
                hash: dir_name,
                display_name,
                full_path,
                last_used,
            }
        })
        .collect();

    Ok(projects)
}

/// Find the newest .jsonl file in a directory, returning its path and modification time (unix seconds).
fn newest_jsonl_file(dir: &std::path::Path) -> Option<(std::path::PathBuf, u64)> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|f| {
            let mtime = f.metadata().ok()?.modified().ok()?;
            let secs = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            Some((f.path(), secs))
        })
        .max_by_key(|(_, t)| *t)
}

/// Read the `cwd` field from the first line of the newest .jsonl file in a project directory.
fn read_cwd_from_jsonl(project_dir: &std::path::Path) -> Option<String> {
    let (path, _) = newest_jsonl_file(project_dir)?;
    let file = std::fs::File::open(path).ok()?;
    let first_line = std::io::BufReader::new(file).lines().next()?.ok()?;
    let json: serde_json::Value = serde_json::from_str(&first_line).ok()?;
    json.get("cwd")?.as_str().map(|s| s.to_string())
}

/// Derive a display name from a full path: last 2 components (e.g. "telvana/telvana-pipecat").
/// Home directory shows as "~".
fn display_name_from_path(path: &str) -> String {
    let p = std::path::Path::new(path);

    // Special case: home directory
    if let Some(home) = dirs::home_dir() {
        if p == home {
            return "~".to_string();
        }
    }

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    if let Some(parent_name) = p.parent().and_then(|pp| pp.file_name()) {
        format!("{}/{}", parent_name.to_string_lossy(), name)
    } else {
        name
    }
}

#[command]
pub async fn browse_for_folder(app: AppHandle) -> Result<Option<String>, String> {
    let path = app.dialog().file().blocking_pick_folder();

    Ok(path.and_then(|p| {
        p.as_path()
            .map(|path| path.to_string_lossy().to_string())
    }))
}
