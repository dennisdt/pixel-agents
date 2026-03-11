use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::persistence::directory_stats;
use crate::state::agent_state::AgentState;
use crate::tty::jsonl_subagent::{JsonlEvent, JsonlReader};
use crate::tty::parser::{self, AgentActivity};
use crate::tty::{self, reader};

/// Info about a running claude process.
pub struct ClaudeProcess {
    pub pid: u32,
    pub tty: String,
    pub project_dir_hash: String,
    pub session_id: Option<String>,
    pub cwd: String,
}

const GLOBAL_SCAN_INTERVAL_MS: u64 = 2000;
const STALE_THRESHOLD: u32 = 2;
const TOOL_DONE_DELAY_MS: u64 = 300;
const STATS_SAVE_INTERVAL_SECS: u64 = 30;

/// Scan `ps` for all running claude processes and return their info.
/// Uses a single batched `lsof` call for all discovered PIDs.
pub fn get_running_claude_processes() -> Vec<ClaudeProcess> {
    let output = match std::process::Command::new("ps")
        .args(["-eo", "pid,tty,args"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let stdout = String::from_utf8_lossy(&output.stdout);

    // First pass: collect candidate processes (PID, tty, session_id)
    let mut candidates = vec![];
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 || parts[2] != "claude" {
            continue;
        }
        let Ok(pid) = parts[0].parse::<u32>() else {
            continue;
        };
        let tty = parts[1];
        if tty == "??" || tty == "TTY" {
            continue;
        }

        let session_id = parts
            .windows(2)
            .find(|w| w[0] == "--session-id")
            .map(|w| w[1].to_string());

        candidates.push((pid, format!("/dev/{}", tty), session_id));
    }

    if candidates.is_empty() {
        return vec![];
    }

    // Batch lsof call for all PIDs at once
    let pid_list: String = candidates
        .iter()
        .map(|(pid, _, _)| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let cwds = batch_get_process_cwds(&pid_list);

    candidates
        .into_iter()
        .filter_map(|(pid, tty, session_id)| {
            let cwd = cwds.get(&pid)?.clone();
            Some(ClaudeProcess {
                pid,
                tty,
                project_dir_hash: tty::hash_path(std::path::Path::new(&cwd)),
                session_id,
                cwd,
            })
        })
        .collect()
}

/// Get CWDs for multiple processes in a single `lsof` call.
/// lsof output groups results by PID: `p<pid>\nfcwd\nn<path>\n...`
fn batch_get_process_cwds(pid_list: &str) -> HashMap<u32, String> {
    let output = match std::process::Command::new("lsof")
        .args(["-p", pid_list, "-Fn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return HashMap::new(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut result = HashMap::new();
    let mut current_pid: Option<u32> = None;
    let mut found_cwd = false;

    for line in stdout.lines() {
        if let Some(pid_str) = line.strip_prefix('p') {
            current_pid = pid_str.parse().ok();
            found_cwd = false;
        } else if line == "fcwd" {
            found_cwd = true;
        } else if found_cwd && line.starts_with('n') {
            let path = &line[1..];
            if !path.is_empty() {
                if let Some(pid) = current_pid {
                    result.insert(pid, path.to_string());
                }
            }
            found_cwd = false;
        } else {
            found_cwd = false;
        }
    }

    result
}

/// Search `root` up to `max_depth` levels deep for a directory whose hashed path == `target_hash`.
/// Returns the display name (last 1-2 path components, e.g. "org/repo-name") and full path.
fn search_for_matching_path(
    root: &std::path::Path,
    target_hash: &str,
    max_depth: u32,
    depth: u32,
) -> Option<(String, PathBuf)> {
    if depth > max_depth {
        return None;
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if tty::hash_path(&path) == target_hash {
            let name = path.file_name()?.to_string_lossy().to_string();
            let display = if let Some(parent_name) = path
                .parent()
                .filter(|p| *p != root)
                .and_then(|p| p.file_name())
            {
                format!("{}/{}", parent_name.to_string_lossy(), name)
            } else {
                name
            };
            return Some((display, path));
        }
        if let Some(result) = search_for_matching_path(&path, target_hash, max_depth, depth + 1) {
            return Some(result);
        }
    }
    None
}

/// Resolve a Claude project directory hash to a display name and full filesystem path.
fn resolve_project_path(project_dir_name: &str) -> (String, Option<String>) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return (fallback_folder_name(project_dir_name), None),
    };

    let roots = build_search_roots(&home);

    for root in &roots {
        if let Some((display, full_path)) =
            search_for_matching_path(root, project_dir_name, 4, 0)
        {
            return (display, Some(full_path.to_string_lossy().to_string()));
        }
    }

    (fallback_folder_name(project_dir_name), None)
}

/// Build the list of filesystem roots to search for project directories.
fn build_search_roots(home: &std::path::Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![
        home.to_path_buf(),
        home.join("projects"),
        home.join("Projects"),
        home.join("Developer"),
        home.join("dev"),
        home.join("code"),
        home.join("src"),
        home.join("work"),
        home.join("Documents"),
    ];

    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let vol_path = entry.path();
            if vol_path.is_dir() {
                roots.push(vol_path.clone());
                for sub in &["Home/projects", "projects", "Users"] {
                    roots.push(vol_path.join(sub));
                }
            }
        }
    }

    roots
}

/// Fallback: use stop-word heuristic when filesystem search fails.
pub fn fallback_folder_name(project_dir_name: &str) -> String {
    if let Some(idx) = project_dir_name.rfind("projects-") {
        let after = &project_dir_name[idx + "projects-".len()..];
        if !after.is_empty() {
            return after.to_string();
        }
    }

    let segments: Vec<&str> = project_dir_name
        .split('-')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() >= 2 {
        segments[segments.len() - 2..].join("-")
    } else {
        project_dir_name.to_string()
    }
}

/// Helper to emit a backend event, ignoring errors.
fn emit(app: &AppHandle, event: serde_json::Value) {
    let _ = app.emit("backend-event", event);
}

/// Start the global scan loop that discovers Claude processes, reads TTY state, and emits events.
pub fn start_global_scan(
    known_pids: Arc<Mutex<HashSet<u32>>>,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    next_agent_id: Arc<Mutex<u32>>,
    next_terminal_index: Arc<Mutex<u32>>,
    directory_stats: Arc<Mutex<HashMap<String, u64>>>,
    directory_stats_dirty: Arc<AtomicBool>,
    app: AppHandle,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_stats_save = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(GLOBAL_SCAN_INTERVAL_MS)).await;

            // Run blocking process discovery on a blocking thread
            let running = tokio::task::spawn_blocking(get_running_claude_processes)
                .await
                .unwrap_or_default();
            let running_pids: HashSet<u32> = running.iter().map(|p| p.pid).collect();

            // Discover new PIDs — reconcile with existing agents created via create_agent
            for proc in &running {
                {
                    let mut pids = known_pids.lock().unwrap();
                    if pids.contains(&proc.pid) {
                        continue;
                    }
                    pids.insert(proc.pid);
                }

                // Check if an existing agent matches this process, and reconcile in a single lock
                let reconciled = {
                    let mut lock = agents.lock().unwrap();
                    let existing_id = lock.iter().find_map(|(&id, a)| {
                        if a.pid == Some(proc.pid) {
                            return Some(id);
                        }
                        if a.pid.is_none() {
                            if let Some(ref proc_sid) = proc.session_id {
                                if a.session_id == *proc_sid {
                                    return Some(id);
                                }
                            }
                        }
                        None
                    });

                    if let Some(id) = existing_id {
                        if let Some(agent) = lock.get_mut(&id) {
                            agent.pid = Some(proc.pid);
                            agent.tty = Some(proc.tty.clone());
                            if agent.cwd.is_none() {
                                agent.cwd = Some(proc.cwd.clone());
                            }
                        }
                        // Reconciled existing agent with newly-discovered PID
                        true
                    } else {
                        false
                    }
                };

                if reconciled {
                    continue;
                }

                let session_id = proc
                    .session_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                let Some(home) = dirs::home_dir() else {
                    continue;
                };
                let project_dir = home
                    .join(".claude/projects")
                    .join(&proc.project_dir_hash);

                let hash_clone = proc.project_dir_hash.clone();
                let folder_name = tokio::task::spawn_blocking(move || {
                    let (display, _) = resolve_project_path(&hash_clone);
                    display
                })
                .await
                .unwrap_or_else(|_| fallback_folder_name(&proc.project_dir_hash));

                let (agent_id, terminal_index) = {
                    let mut nid = next_agent_id.lock().unwrap();
                    let id = *nid;
                    *nid += 1;
                    let mut ntidx = next_terminal_index.lock().unwrap();
                    let tidx = *ntidx;
                    *ntidx += 1;
                    (id, tidx)
                };

                let mut agent =
                    AgentState::new(agent_id, session_id, project_dir, terminal_index);
                agent.is_external = true;
                agent.folder_name = Some(folder_name.clone());
                agent.pid = Some(proc.pid);
                agent.tty = Some(proc.tty.clone());
                agent.cwd = Some(proc.cwd.clone());

                agents.lock().unwrap().insert(agent_id, agent);

                emit(&app, serde_json::json!({
                    "type": "agentCreated",
                    "id": agent_id,
                    "isExternal": true,
                    "folderName": folder_name,
                    "cwd": proc.cwd,
                }));

                // Agent discovered and created
            }

            // Batch read all terminal screen contents
            let histories = reader::read_all_terminal_contents().await;

            // For each agent, parse state, diff, and handle sub-agents
            let agent_snapshots: Vec<_> = {
                let lock = agents.lock().unwrap();
                lock.values()
                    .map(|a| (a.id, a.tty.clone(), a.last_content_hash, a.last_activity.clone()))
                    .collect()
            };

            for (agent_id, tty, last_hash, last_activity) in agent_snapshots {
                let Some(ref tty_path) = tty else {
                    continue;
                };
                let Some(content) = histories.get(tty_path) else {
                    continue;
                };

                let new_activity = parser::parse_terminal_state(content);
                let new_hash = parser::content_fingerprint(content);
                // Definitive active signal from Claude's TUI — only present when processing.
                let confirmed_active = content.contains(parser::ACTIVE_SENTINEL);

                // Staleness detection + activity update in a single lock
                let effective_activity = {
                    let mut lock = agents.lock().unwrap();
                    let Some(agent) = lock.get_mut(&agent_id) else {
                        continue;
                    };

                    let activity = if new_hash == last_hash {
                        agent.stale_count += 1;
                        if agent.stale_count >= STALE_THRESHOLD && !confirmed_active {
                            match &new_activity {
                                AgentActivity::Thinking | AgentActivity::Unknown => AgentActivity::Waiting,
                                _ => new_activity.clone(),
                            }
                        } else {
                            new_activity.clone()
                        }
                    } else {
                        agent.stale_count = 0;
                        agent.last_content_hash = new_hash;
                        new_activity.clone()
                    };

                    agent.last_activity = Some(activity.clone());
                    activity
                };

                emit_state_transitions(
                    agent_id,
                    &last_activity,
                    &effective_activity,
                    &app,
                );

                // Read JSONL for detailed tool tracking (primary + subagent)
                handle_jsonl_events(agent_id, &agents, &directory_stats, &directory_stats_dirty, &app);
            }

            // Cleanup agents whose PID is gone
            let dead_agents: Vec<(u32, Option<u32>)> = {
                let lock = agents.lock().unwrap();
                lock.iter()
                    .filter(|(_, a)| {
                        if a.created_at.elapsed() < Duration::from_secs(15) {
                            return false;
                        }
                        match a.pid {
                            Some(pid) => !running_pids.contains(&pid),
                            None => {
                                let hash = a
                                    .project_dir
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_default();
                                !running.iter().any(|p| p.project_dir_hash == hash)
                            }
                        }
                    })
                    .map(|(&id, a)| (id, a.pid))
                    .collect()
            };

            for (id, pid) in dead_agents {
                // Agent session ended

                if let Some(pid) = pid {
                    known_pids.lock().unwrap().remove(&pid);
                }
                agents.lock().unwrap().remove(&id);

                emit(&app, serde_json::json!({
                    "type": "agentClosed",
                    "id": id,
                }));
            }

            // Periodic save of directory stats
            if directory_stats_dirty.load(Ordering::SeqCst)
                && last_stats_save.elapsed() >= Duration::from_secs(STATS_SAVE_INTERVAL_SECS)
            {
                directory_stats_dirty.store(false, Ordering::SeqCst);
                let snapshot = directory_stats.lock().unwrap().clone();
                tokio::task::spawn_blocking(move || {
                    let _ = directory_stats::save_directory_stats(&snapshot);
                });
                last_stats_save = Instant::now();
            }
        }
    })
}

/// Emit events based on the transition from previous to new activity state.
/// TTY only handles coarse state (active/waiting/permission). Tool-level detail comes from JSONL.
fn emit_state_transitions(
    agent_id: u32,
    prev: &Option<AgentActivity>,
    new: &AgentActivity,
    app: &AppHandle,
) {
    let prev = prev.as_ref().unwrap_or(&AgentActivity::Unknown);

    if prev == new {
        return;
    }

    let was_active = matches!(
        prev,
        AgentActivity::ToolActive { .. } | AgentActivity::Thinking | AgentActivity::Unknown
    );

    // Leaving permission state
    if matches!(prev, AgentActivity::PermissionNeeded { .. }) {
        emit(app, serde_json::json!({
            "type": "agentToolPermissionClear",
            "id": agent_id,
        }));
    }

    // Emit status changes
    match new {
        AgentActivity::Waiting => {
            emit(app, serde_json::json!({
                "type": "agentStatus",
                "id": agent_id,
                "status": "waiting",
            }));
        }

        AgentActivity::PermissionNeeded { .. } => {
            emit(app, serde_json::json!({
                "type": "agentToolPermission",
                "id": agent_id,
            }));
        }

        AgentActivity::ToolActive { .. } | AgentActivity::Thinking => {
            if !was_active {
                emit(app, serde_json::json!({
                    "type": "agentStatus",
                    "id": agent_id,
                    "status": "active",
                }));
            }
        }

        AgentActivity::Unknown => {}
    }
}

/// Read JSONL events for primary tool tracking and subagent progress.
fn handle_jsonl_events(
    agent_id: u32,
    agents: &Arc<Mutex<HashMap<u32, AgentState>>>,
    directory_stats: &Arc<Mutex<HashMap<String, u64>>>,
    directory_stats_dirty: &Arc<AtomicBool>,
    app: &AppHandle,
) {
    let events = {
        let mut lock = agents.lock().unwrap();
        let Some(agent) = lock.get_mut(&agent_id) else { return };
        if agent.jsonl_reader.is_none() {
            agent.jsonl_reader = Some(JsonlReader::new());
        }
        let reader = agent.jsonl_reader.as_mut().unwrap();
        reader.read_events_from_project(&agent.project_dir)
    };

    if events.is_empty() {
        return;
    }

    // JSONL events available for this agent

    // Batch subagent state updates under one lock
    {
        let mut lock = agents.lock().unwrap();
        if let Some(agent) = lock.get_mut(&agent_id) {
            for event in &events {
                match event {
                    JsonlEvent::SubagentToolStart { parent_tool_id, tool_id, tool_name, .. } => {
                        agent
                            .active_subagent_tool_names
                            .entry(parent_tool_id.clone())
                            .or_default()
                            .insert(tool_id.clone(), tool_name.clone());
                    }
                    JsonlEvent::SubagentToolDone { parent_tool_id, tool_id } => {
                        if let Some(sub_names) =
                            agent.active_subagent_tool_names.get_mut(parent_tool_id)
                        {
                            sub_names.remove(tool_id);
                        }
                    }
                    JsonlEvent::TurnEnd => {
                        agent.active_subagent_tool_names.clear();
                    }
                    _ => {}
                }
            }
        }
    }

    // Emit events outside the lock
    for event in events {
        match event {
            JsonlEvent::ToolStart { tool_id, status, .. } => {
                emit(app, serde_json::json!({
                    "type": "agentStatus",
                    "id": agent_id,
                    "status": "active",
                }));
                emit(app, serde_json::json!({
                    "type": "agentToolStart",
                    "id": agent_id,
                    "toolId": tool_id,
                    "status": status,
                }));
            }
            JsonlEvent::ToolDone { tool_id } => {
                let app_clone = app.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(TOOL_DONE_DELAY_MS)).await;
                    emit(&app_clone, serde_json::json!({
                        "type": "agentToolDone",
                        "id": agent_id,
                        "toolId": tool_id,
                    }));
                });
            }
            JsonlEvent::TurnEnd => {
                emit(app, serde_json::json!({
                    "type": "agentToolsClear",
                    "id": agent_id,
                }));
                emit(app, serde_json::json!({
                    "type": "agentStatus",
                    "id": agent_id,
                    "status": "waiting",
                }));
            }
            JsonlEvent::SubagentToolStart { parent_tool_id, tool_id, status, .. } => {
                emit(app, serde_json::json!({
                    "type": "subagentToolStart",
                    "id": agent_id,
                    "parentToolId": parent_tool_id,
                    "toolId": tool_id,
                    "status": status,
                }));
            }
            JsonlEvent::SubagentToolDone { parent_tool_id, tool_id } => {
                let app_clone = app.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(TOOL_DONE_DELAY_MS)).await;
                    emit(&app_clone, serde_json::json!({
                        "type": "subagentToolDone",
                        "id": agent_id,
                        "parentToolId": parent_tool_id,
                        "toolId": tool_id,
                    }));
                });
            }
            JsonlEvent::TokenUsage { output_tokens } => {
                let cwd = agents.lock().unwrap().get(&agent_id)
                    .and_then(|a| a.cwd.clone());
                if let Some(dir) = cwd {
                    let new_total = {
                        let mut stats = directory_stats.lock().unwrap();
                        let total = stats.entry(dir.clone()).or_insert(0);
                        *total += output_tokens;
                        *total
                    };
                    directory_stats_dirty.store(true, Ordering::SeqCst);
                    emit(app, serde_json::json!({
                        "type": "directoryExp",
                        "directory": dir,
                        "totalExp": new_total,
                    }));
                }
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fallback_folder_name() {
        assert_eq!(
            fallback_folder_name("Users-john-projects-my-app"),
            "my-app"
        );
        assert_eq!(
            fallback_folder_name("home-user-projects-project"),
            "project"
        );
        assert_eq!(
            fallback_folder_name("some-unknown-path"),
            "unknown-path"
        );
    }

    #[test]
    fn test_hash_path() {
        let p = std::path::Path::new("/Volumes/SSD/Home/projects/my-app");
        assert_eq!(tty::hash_path(p), "-Volumes-SSD-Home-projects-my-app");
    }
}
