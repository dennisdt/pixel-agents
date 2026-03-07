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

/// Derive a human-readable folder name from a Claude project directory name.
/// Project dir names look like: `Users-dennistran-projects-personal-pixel-agents`
/// Strategy: scan backwards from the end, stop at common path segments.
fn derive_folder_name(project_dir_name: &str) -> String {
    let segments: Vec<&str> = project_dir_name.split('-').collect();

    let stop_words: &[&str] = &[
        "Users", "home", "root", "Volumes", "projects", "personal", "work", "dev", "src",
        "code", "repos", "Documents", "Desktop", "workspace", "workspaces", "github", "gitlab",
        "mnt", "opt", "var", "tmp", "Home",
    ];

    // Scan from end backwards, find the last stop word
    let mut cut = 0;
    for (i, seg) in segments.iter().enumerate().rev() {
        if stop_words.contains(seg) {
            cut = i + 1;
            break;
        }
    }

    if cut < segments.len() {
        segments[cut..].join("-")
    } else if segments.len() >= 2 {
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
    fn test_derive_folder_name() {
        assert_eq!(
            derive_folder_name("Users-dennistran-projects-personal-pixel-agents"),
            "pixel-agents"
        );
        assert_eq!(
            derive_folder_name("Users-john-code-my-app"),
            "my-app"
        );
        assert_eq!(
            derive_folder_name("home-user-dev-project"),
            "project"
        );
        assert_eq!(
            derive_folder_name("Volumes-SSD-Users-dennis-projects-foo"),
            "foo"
        );
    }
}
