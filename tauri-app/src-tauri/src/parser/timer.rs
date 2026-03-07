use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tokio::time::{sleep, Duration};

use crate::state::agent_state::AgentState;

const PERMISSION_TIMER_DELAY_MS: u64 = 7000;

pub type TimerMap = Arc<Mutex<HashMap<u32, watch::Sender<()>>>>;

pub fn new_timer_map() -> TimerMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn cancel_timer(agent_id: u32, timers: &TimerMap) {
    let mut map = timers.lock().unwrap();
    if let Some(tx) = map.remove(&agent_id) {
        let _ = tx.send(());
    }
}

pub fn start_waiting_timer(
    agent_id: u32,
    delay_ms: u64,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    waiting_timers: TimerMap,
    app: AppHandle,
) {
    cancel_timer(agent_id, &waiting_timers);

    let (tx, mut rx) = watch::channel(());
    waiting_timers.lock().unwrap().insert(agent_id, tx);

    tokio::spawn(async move {
        tokio::select! {
            _ = sleep(Duration::from_millis(delay_ms)) => {
                waiting_timers.lock().unwrap().remove(&agent_id);
                if let Some(agent) = agents.lock().unwrap().get_mut(&agent_id) {
                    agent.is_waiting = true;
                }
                let _ = app.emit("backend-event", serde_json::json!({
                    "type": "agentStatus",
                    "id": agent_id,
                    "status": "waiting",
                }));
            }
            _ = rx.changed() => {
                // Cancelled
            }
        }
    });
}

pub fn start_permission_timer(
    agent_id: u32,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    permission_timers: TimerMap,
    app: AppHandle,
) {
    cancel_timer(agent_id, &permission_timers);

    let (tx, mut rx) = watch::channel(());
    permission_timers.lock().unwrap().insert(agent_id, tx);

    let exempt_tools: std::collections::HashSet<&str> =
        ["Task", "AskUserQuestion"].iter().copied().collect();

    tokio::spawn(async move {
        tokio::select! {
            _ = sleep(Duration::from_millis(PERMISSION_TIMER_DELAY_MS)) => {
                permission_timers.lock().unwrap().remove(&agent_id);
                let agents_lock = agents.lock().unwrap();
                let Some(agent) = agents_lock.get(&agent_id) else { return };

                let mut has_non_exempt = false;
                let mut stuck_parent_ids: Vec<String> = Vec::new();

                for tool_id in &agent.active_tool_ids {
                    if let Some(name) = agent.active_tool_names.get(tool_id) {
                        if !exempt_tools.contains(name.as_str()) {
                            has_non_exempt = true;
                            break;
                        }
                    }
                }

                for (parent_id, sub_names) in &agent.active_subagent_tool_names {
                    for name in sub_names.values() {
                        if !exempt_tools.contains(name.as_str()) {
                            stuck_parent_ids.push(parent_id.clone());
                            has_non_exempt = true;
                            break;
                        }
                    }
                }

                if has_non_exempt {
                    drop(agents_lock);
                    if let Some(agent) = agents.lock().unwrap().get_mut(&agent_id) {
                        agent.permission_sent = true;
                    }
                    let _ = app.emit("backend-event", serde_json::json!({
                        "type": "agentToolPermission",
                        "id": agent_id,
                    }));
                    for parent_id in stuck_parent_ids {
                        let _ = app.emit("backend-event", serde_json::json!({
                            "type": "subagentToolPermission",
                            "id": agent_id,
                            "parentToolId": parent_id,
                        }));
                    }
                }
            }
            _ = rx.changed() => {
                // Cancelled
            }
        }
    });
}

pub fn clear_agent_activity(
    agent: &mut AgentState,
    agent_id: u32,
    permission_timers: &TimerMap,
    app: &AppHandle,
) {
    agent.active_tool_ids.clear();
    agent.active_tool_statuses.clear();
    agent.active_tool_names.clear();
    agent.active_subagent_tool_ids.clear();
    agent.active_subagent_tool_names.clear();
    agent.is_waiting = false;
    agent.permission_sent = false;
    cancel_timer(agent_id, permission_timers);
    let _ = app.emit("backend-event", serde_json::json!({
        "type": "agentToolsClear", "id": agent_id,
    }));
    let _ = app.emit("backend-event", serde_json::json!({
        "type": "agentStatus", "id": agent_id, "status": "active",
    }));
}
