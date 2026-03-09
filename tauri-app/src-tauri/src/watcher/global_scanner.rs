use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::parser::timer::TimerMap;
use crate::state::agent_state::AgentState;
use crate::watcher::file_watcher;

const GLOBAL_SCAN_INTERVAL_MS: u64 = 3000;
const MAX_MTIME_AGE_SECS: u64 = 120;

/// Hash a filesystem path the same way Claude does: replace non-alphanumeric/hyphen chars with `-`.
fn hash_path(p: &std::path::Path) -> String {
    p.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

/// Search `root` up to `max_depth` levels deep for a directory whose hashed path == `target_hash`.
/// Returns the last 1-2 path components as a display name (e.g. "org/repo-name").
fn search_for_matching_path(
    root: &std::path::Path,
    target_hash: &str,
    max_depth: u32,
    depth: u32,
) -> Option<String> {
    if depth > max_depth {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if hash_path(&path) == target_hash {
            // Found! Return last 2 path components for context (e.g. "org/repo")
            let name = path.file_name()?.to_string_lossy().to_string();
            // If parent is the search root, just return the name
            if path.parent().map(|p| p == root).unwrap_or(true) {
                return Some(name);
            }
            // Otherwise include parent dir for context: "parent/name"
            if let Some(parent_name) = path.parent().and_then(|p| p.file_name()) {
                return Some(format!("{}/{}", parent_name.to_string_lossy(), name));
            }
            return Some(name);
        }
        // Recurse deeper
        if let Some(result) = search_for_matching_path(&path, target_hash, max_depth, depth + 1) {
            return Some(result);
        }
    }
    None
}

/// Derive a human-readable folder name from a Claude project directory name.
/// Project dir names are hashed paths like: `-Volumes-SSD-Home-projects-org-my-app`
/// Strategy: search common directories on disk to find the real path that matches,
/// then return the actual directory name (preserving slashes and original casing).
fn derive_folder_name(project_dir_name: &str) -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return fallback_folder_name(project_dir_name),
    };

    let mut roots: Vec<PathBuf> = vec![
        home.clone(),
        home.join("projects"),
        home.join("Projects"),
        home.join("Developer"),
        home.join("dev"),
        home.join("code"),
        home.join("src"),
        home.join("work"),
        home.join("Documents"),
    ];

    // Check /Volumes/*/ and common subdirectories
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let vol_path = entry.path();
            if vol_path.is_dir() {
                roots.push(vol_path.clone());
                for sub in &["Home/projects", "projects", "Users"] {
                    let vol_sub = vol_path.join(sub);
                    if vol_sub.exists() {
                        roots.push(vol_sub);
                    }
                }
            }
        }
    }

    // Search up to 4 levels deep from each root
    for root in &roots {
        if !root.exists() {
            continue;
        }
        if let Some(name) = search_for_matching_path(root, project_dir_name, 4, 0) {
            return name;
        }
    }

    fallback_folder_name(project_dir_name)
}

/// Fallback: use stop-word heuristic when filesystem search fails.
fn fallback_folder_name(project_dir_name: &str) -> String {
    // Try regex-style match: everything after "projects-"
    if let Some(idx) = project_dir_name.rfind("projects-") {
        let after = &project_dir_name[idx + "projects-".len()..];
        if !after.is_empty() {
            return after.to_string();
        }
    }

    // Last resort: last 2 segments
    let segments: Vec<&str> = project_dir_name.split('-').filter(|s| !s.is_empty()).collect();
    if segments.len() >= 2 {
        segments[segments.len() - 2..].join("-")
    } else {
        project_dir_name.to_string()
    }
}

/// Start scanning `~/.claude/projects/*/` for active JSONL files from external Claude sessions.
pub fn start_global_scan(
    known_jsonl_files: Arc<Mutex<HashSet<PathBuf>>>,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    next_agent_id: Arc<Mutex<u32>>,
    next_terminal_index: Arc<Mutex<u32>>,
    waiting_timers: TimerMap,
    permission_timers: TimerMap,
    file_abort_handles: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
    app: AppHandle,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(GLOBAL_SCAN_INTERVAL_MS)).await;

            let claude_projects_dir = match dirs::home_dir() {
                Some(home) => home.join(".claude").join("projects"),
                None => continue,
            };

            if !claude_projects_dir.exists() {
                continue;
            }

            // Read all project subdirectories
            let project_dirs: Vec<PathBuf> = match std::fs::read_dir(&claude_projects_dir) {
                Ok(entries) => entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .collect(),
                Err(_) => continue,
            };

            for project_dir in project_dirs {
                let entries = match std::fs::read_dir(&project_dir) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(true, |ext| ext != "jsonl") {
                        continue;
                    }

                    // Skip if already known
                    {
                        let known = known_jsonl_files.lock().unwrap();
                        if known.contains(&path) {
                            continue;
                        }
                    }

                    // Check mtime — skip if older than threshold
                    let mtime_ok = match std::fs::metadata(&path) {
                        Ok(meta) => match meta.modified() {
                            Ok(mtime) => match SystemTime::now().duration_since(mtime) {
                                Ok(age) => age.as_secs() < MAX_MTIME_AGE_SECS,
                                Err(_) => true, // mtime in the future, treat as active
                            },
                            Err(_) => false,
                        },
                        Err(_) => false,
                    };
                    if !mtime_ok {
                        continue;
                    }

                    // Extract session_id from filename
                    let session_id = match path.file_stem() {
                        Some(stem) => stem.to_string_lossy().to_string(),
                        None => continue,
                    };

                    // Derive folder name from project dir name
                    let project_dir_name = project_dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let folder_name = derive_folder_name(&project_dir_name);

                    // Allocate agent ID and terminal index
                    let (agent_id, terminal_index) = {
                        let mut nid = next_agent_id.lock().unwrap();
                        let id = *nid;
                        *nid += 1;
                        let mut ntidx = next_terminal_index.lock().unwrap();
                        let tidx = *ntidx;
                        *ntidx += 1;
                        (id, tidx)
                    };

                    // Mark as known
                    known_jsonl_files.lock().unwrap().insert(path.clone());

                    // Create external agent state
                    let mut agent = AgentState::new(
                        agent_id,
                        session_id,
                        project_dir.clone(),
                        terminal_index,
                    );
                    agent.jsonl_file = Some(path.clone());
                    agent.is_external = true;
                    agent.folder_name = Some(folder_name.clone());

                    agents.lock().unwrap().insert(agent_id, agent);

                    // Emit agentCreated with isExternal flag
                    let _ = app.emit(
                        "backend-event",
                        serde_json::json!({
                            "type": "agentCreated",
                            "id": agent_id,
                            "isExternal": true,
                            "folderName": folder_name,
                        }),
                    );

                    println!(
                        "[Pixel Agents] Global scan: discovered external session {} in {} (agent {})",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        folder_name,
                        agent_id,
                    );

                    // Start file watching
                    file_watcher::start_file_watching(
                        agent_id,
                        path.clone(),
                        agents.clone(),
                        waiting_timers.clone(),
                        permission_timers.clone(),
                        app.clone(),
                        file_abort_handles.clone(),
                    );

                    // Do initial read to catch up on existing content
                    file_watcher::read_new_lines(
                        agent_id,
                        &agents,
                        &waiting_timers,
                        &permission_timers,
                        &app,
                    );
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fallback_folder_name() {
        // When filesystem search fails, fallback heuristic kicks in
        assert_eq!(
            fallback_folder_name("Users-john-projects-my-app"),
            "my-app"
        );
        assert_eq!(
            fallback_folder_name("home-user-projects-project"),
            "project"
        );
        // Last resort: last 2 segments
        assert_eq!(
            fallback_folder_name("some-unknown-path"),
            "unknown-path"
        );
    }

    #[test]
    fn test_hash_path() {
        let p = std::path::Path::new("/Volumes/SSD/Home/projects/my-app");
        assert_eq!(hash_path(p), "-Volumes-SSD-Home-projects-my-app");
    }
}
