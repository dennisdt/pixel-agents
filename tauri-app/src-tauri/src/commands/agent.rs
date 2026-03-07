use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, Emitter, Manager};

use crate::parser::timer::{self, TimerMap};
use crate::persistence::layout::get_project_dir_path;
use crate::pty::manager::PtyManager;
use crate::state::agent_state::AgentState;
use crate::state::app_state::AppState;
use crate::watcher::{file_watcher, project_scanner};

/// Shared watcher state managed as Tauri state
pub struct WatcherState {
    pub agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    pub waiting_timers: TimerMap,
    pub permission_timers: TimerMap,
    pub file_abort_handles: Arc<Mutex<HashMap<u32, tokio::task::JoinHandle<()>>>>,
    pub jsonl_poll_handles: Arc<Mutex<HashMap<u32, tokio::task::JoinHandle<()>>>>,
    pub project_scan_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub global_scan_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            waiting_timers: timer::new_timer_map(),
            permission_timers: timer::new_timer_map(),
            file_abort_handles: Arc::new(Mutex::new(HashMap::new())),
            jsonl_poll_handles: Arc::new(Mutex::new(HashMap::new())),
            project_scan_handle: Mutex::new(None),
            global_scan_handle: Mutex::new(None),
        }
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

#[command]
pub async fn create_agent(
    app: AppHandle,
    folder_path: Option<String>,
) -> Result<u32, String> {
    let app_state = app.state::<AppState>();
    let watcher = app.state::<WatcherState>();
    let pty_mgr = app.state::<PtyManager>();

    let cwd = folder_path.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let session_id = uuid::Uuid::new_v4().to_string();
    let project_dir = get_project_dir_path(&cwd);

    let id = {
        let mut next_id = app_state.next_agent_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;
        id
    };

    let terminal_index = {
        let mut next_idx = app_state.next_terminal_index.lock().unwrap();
        let idx = *next_idx;
        *next_idx += 1;
        idx
    };

    // Pre-register expected JSONL file
    let expected_file = project_dir.join(format!("{}.jsonl", session_id));
    app_state
        .known_jsonl_files
        .lock()
        .unwrap()
        .insert(expected_file.clone());

    // Create agent state
    let mut agent = AgentState::new(id, session_id.clone(), project_dir.clone(), terminal_index);
    agent.jsonl_file = Some(expected_file.clone());

    watcher.agents.lock().unwrap().insert(id, agent);

    // Spawn PTY
    pty_mgr.create_pty(id, &cwd, &session_id, app.clone())?;

    // Emit agent created
    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "agentCreated",
            "id": id,
        }),
    );

    // Start project scan if not already running
    {
        let mut scan_handle = watcher.project_scan_handle.lock().unwrap();
        if scan_handle.is_none() {
            let handle = project_scanner::start_project_scan(
                project_dir.clone(),
                app_state.known_jsonl_files.clone(),
                watcher.agents.clone(),
                watcher.waiting_timers.clone(),
                watcher.permission_timers.clone(),
                watcher.file_abort_handles.clone(),
                app.clone(),
            );
            *scan_handle = Some(handle);
        }
    }

    // Poll for JSONL file to appear, then start watching
    let agents = watcher.agents.clone();
    let waiting = watcher.waiting_timers.clone();
    let perms = watcher.permission_timers.clone();
    let abort_handles = watcher.file_abort_handles.clone();
    let poll_handles = watcher.jsonl_poll_handles.clone();
    let app_clone = app.clone();
    let expected = expected_file.clone();

    let poll_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            if !agents.lock().unwrap().contains_key(&id) {
                break;
            }

            if expected.exists() {
                println!(
                    "[Pixel Agents] Agent {}: found JSONL file {:?}",
                    id,
                    expected.file_name().unwrap_or_default()
                );
                poll_handles.lock().unwrap().remove(&id);

                file_watcher::start_file_watching(
                    id,
                    expected.clone(),
                    agents.clone(),
                    waiting.clone(),
                    perms.clone(),
                    app_clone.clone(),
                    abort_handles.clone(),
                );
                file_watcher::read_new_lines(id, &agents, &waiting, &perms, &app_clone);
                break;
            }
        }
    });

    watcher.jsonl_poll_handles.lock().unwrap().insert(id, poll_handle);

    // Store project hash for seat persistence
    {
        let dir_name: String = cwd
            .chars()
            .map(|c| if c == ':' || c == '\\' || c == '/' { '-' } else { c })
            .filter(|c| c.is_alphanumeric() || *c == '-')
            .collect();
        *app_state.project_hash.lock().unwrap() = Some(dir_name);
    }

    Ok(id)
}

#[command]
pub async fn close_agent(app: AppHandle, id: u32) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let watcher = app.state::<WatcherState>();
    let pty_mgr = app.state::<PtyManager>();

    // Check if this is an external agent
    let is_external = watcher
        .agents
        .lock()
        .unwrap()
        .get(&id)
        .map(|a| a.is_external)
        .unwrap_or(false);

    // For external agents, remove from known_jsonl_files so it can be re-discovered
    if is_external {
        let jsonl_file = watcher
            .agents
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|a| a.jsonl_file.clone());
        if let Some(path) = jsonl_file {
            app_state.known_jsonl_files.lock().unwrap().remove(&path);
        }
    }

    // Stop JSONL poll
    if let Some(handle) = watcher.jsonl_poll_handles.lock().unwrap().remove(&id) {
        handle.abort();
    }

    // Stop file watching
    file_watcher::stop_file_watching(id, &watcher.file_abort_handles);

    // Cancel timers
    timer::cancel_timer(id, &watcher.waiting_timers);
    timer::cancel_timer(id, &watcher.permission_timers);

    // Only close PTY for non-external agents
    if !is_external {
        pty_mgr.close_pty(id);
    }

    // Remove agent
    watcher.agents.lock().unwrap().remove(&id);

    // Notify frontend
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
    // In Tauri, focus just tells the frontend which terminal tab to show
    let _ = app.emit(
        "backend-event",
        serde_json::json!({
            "type": "agentSelected",
            "id": id,
        }),
    );
    Ok(())
}
