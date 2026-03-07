use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

use crate::parser::timer::TimerMap;
use crate::state::agent_state::AgentState;
use crate::watcher::file_watcher;

const PROJECT_SCAN_INTERVAL_MS: u64 = 1000;

/// Start scanning a project directory for new JSONL files (handles /clear creating new sessions).
pub fn start_project_scan(
    project_dir: PathBuf,
    known_files: Arc<Mutex<HashSet<PathBuf>>>,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    waiting_timers: TimerMap,
    permission_timers: TimerMap,
    abort_handles: Arc<Mutex<HashMap<u32, tokio::task::JoinHandle<()>>>>,
    app: AppHandle,
) -> tokio::task::JoinHandle<()> {
    // Seed known files
    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        let mut known = known_files.lock().unwrap();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "jsonl") {
                known.insert(path);
            }
        }
    }

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(PROJECT_SCAN_INTERVAL_MS)).await;

            let entries = match std::fs::read_dir(&project_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let mut new_files = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext == "jsonl") {
                    let mut known = known_files.lock().unwrap();
                    if !known.contains(&path) {
                        known.insert(path.clone());
                        new_files.push(path);
                    }
                }
            }

            for file in new_files {
                // Find the most recently active agent to reassign
                let active_agent_id = {
                    let agents_lock = agents.lock().unwrap();
                    // Pick first agent that has active tools (most likely /clear target)
                    agents_lock
                        .values()
                        .find(|a| !a.active_tool_ids.is_empty() || a.is_waiting)
                        .map(|a| a.id)
                        .or_else(|| agents_lock.keys().max().copied())
                };

                if let Some(agent_id) = active_agent_id {
                    println!(
                        "[Pixel Agents] New JSONL detected: {:?}, reassigning to agent {}",
                        file.file_name().unwrap_or_default(),
                        agent_id
                    );

                    // Stop old file watching
                    file_watcher::stop_file_watching(agent_id, &abort_handles);

                    // Clear activity
                    {
                        let mut agents_lock = agents.lock().unwrap();
                        if let Some(agent) = agents_lock.get_mut(&agent_id) {
                            crate::parser::timer::clear_agent_activity(
                                agent,
                                agent_id,
                                &permission_timers,
                                &app,
                            );
                            agent.jsonl_file = Some(file.clone());
                            agent.file_offset = 0;
                            agent.line_buffer.clear();
                        }
                    }

                    // Start watching new file
                    file_watcher::start_file_watching(
                        agent_id,
                        file,
                        agents.clone(),
                        waiting_timers.clone(),
                        permission_timers.clone(),
                        app.clone(),
                        abort_handles.clone(),
                    );
                }
            }
        }
    })
}
