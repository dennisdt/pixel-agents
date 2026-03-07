use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::parser::timer::{cancel_timer, TimerMap};
use crate::parser::transcript::process_transcript_line;
use crate::state::agent_state::AgentState;

const FILE_WATCHER_POLL_INTERVAL_MS: u64 = 1000;

/// Start watching a JSONL file for new lines using polling.
/// Returns a join handle that can be used to abort the watcher.
pub fn start_file_watching(
    agent_id: u32,
    _file_path: PathBuf,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    waiting_timers: TimerMap,
    permission_timers: TimerMap,
    app: AppHandle,
    abort_handles: Arc<Mutex<HashMap<u32, tokio::task::JoinHandle<()>>>>,
) {
    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(FILE_WATCHER_POLL_INTERVAL_MS)).await;

            if !agents.lock().unwrap().contains_key(&agent_id) {
                break;
            }

            read_new_lines(
                agent_id,
                &agents,
                &waiting_timers,
                &permission_timers,
                &app,
            );
        }
    });

    abort_handles.lock().unwrap().insert(agent_id, handle);
}

/// Read new lines from agent's JSONL file since last offset
pub fn read_new_lines(
    agent_id: u32,
    agents: &Arc<Mutex<HashMap<u32, AgentState>>>,
    waiting_timers: &TimerMap,
    permission_timers: &TimerMap,
    app: &AppHandle,
) {
    let (jsonl_file, file_offset, line_buffer) = {
        let agents_lock = agents.lock().unwrap();
        let Some(agent) = agents_lock.get(&agent_id) else { return };
        let Some(ref jf) = agent.jsonl_file else { return };
        (jf.clone(), agent.file_offset, agent.line_buffer.clone())
    };

    let stat = match fs::metadata(&jsonl_file) {
        Ok(s) => s,
        Err(_) => return,
    };

    let file_size = stat.len();
    if file_size <= file_offset {
        return;
    }

    let mut file = match File::open(&jsonl_file) {
        Ok(f) => f,
        Err(_) => return,
    };

    if file.seek(SeekFrom::Start(file_offset)).is_err() {
        return;
    }

    let bytes_to_read = (file_size - file_offset) as usize;
    let mut buf = vec![0u8; bytes_to_read];
    match file.read_exact(&mut buf) {
        Ok(_) => {}
        Err(_) => return,
    }

    let text = format!("{}{}", line_buffer, String::from_utf8_lossy(&buf));
    let mut lines: Vec<&str> = text.split('\n').collect();
    let remaining = lines.pop().unwrap_or("").to_string();

    // Update agent state
    {
        let mut agents_lock = agents.lock().unwrap();
        if let Some(agent) = agents_lock.get_mut(&agent_id) {
            agent.file_offset = file_size;
            agent.line_buffer = remaining;
        }
    }

    let has_lines = lines.iter().any(|l| !l.trim().is_empty());
    if has_lines {
        cancel_timer(agent_id, waiting_timers);
        cancel_timer(agent_id, permission_timers);

        let permission_sent = agents
            .lock()
            .unwrap()
            .get(&agent_id)
            .map(|a| a.permission_sent)
            .unwrap_or(false);
        if permission_sent {
            if let Some(agent) = agents.lock().unwrap().get_mut(&agent_id) {
                agent.permission_sent = false;
            }
            let _ = app.emit(
                "backend-event",
                serde_json::json!({
                    "type": "agentToolPermissionClear",
                    "id": agent_id,
                }),
            );
        }
    }

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        process_transcript_line(
            agent_id,
            line,
            agents.clone(),
            waiting_timers.clone(),
            permission_timers.clone(),
            app,
        );
    }
}

/// Stop watching files for a given agent
pub fn stop_file_watching(
    agent_id: u32,
    abort_handles: &Arc<Mutex<HashMap<u32, tokio::task::JoinHandle<()>>>>,
) {
    if let Some(handle) = abort_handles.lock().unwrap().remove(&agent_id) {
        handle.abort();
    }
}
