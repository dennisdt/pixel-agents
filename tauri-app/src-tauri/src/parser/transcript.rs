use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::state::agent_state::AgentState;
use super::timer::{
    TimerMap, cancel_timer, clear_agent_activity,
    start_permission_timer, start_waiting_timer,
};

const TOOL_DONE_DELAY_MS: u64 = 300;
const TEXT_IDLE_DELAY_MS: u64 = 5000;
const BASH_CMD_MAX: usize = 30;
const TASK_DESC_MAX: usize = 40;

fn exempt_tools() -> HashSet<&'static str> {
    ["Task", "AskUserQuestion"].iter().copied().collect()
}

fn format_tool_status(tool_name: &str, input: &serde_json::Value) -> String {
    let base = |key: &str| -> String {
        input.get(key)
            .and_then(|v| v.as_str())
            .map(|s| Path::new(s).file_name().unwrap_or_default().to_string_lossy().to_string())
            .unwrap_or_default()
    };

    match tool_name {
        "Read" => format!("Reading {}", base("file_path")),
        "Edit" => format!("Editing {}", base("file_path")),
        "Write" => format!("Writing {}", base("file_path")),
        "Bash" => {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if cmd.len() > BASH_CMD_MAX {
                format!("Running: {}\u{2026}", &cmd[..BASH_CMD_MAX])
            } else {
                format!("Running: {}", cmd)
            }
        }
        "Glob" => "Searching files".into(),
        "Grep" => "Searching code".into(),
        "WebFetch" => "Fetching web content".into(),
        "WebSearch" => "Searching the web".into(),
        "Task" => {
            let desc = input.get("description").and_then(|v| v.as_str()).unwrap_or("");
            if desc.is_empty() {
                "Running subtask".into()
            } else if desc.len() > TASK_DESC_MAX {
                format!("Subtask: {}\u{2026}", &desc[..TASK_DESC_MAX])
            } else {
                format!("Subtask: {}", desc)
            }
        }
        "AskUserQuestion" => "Waiting for your answer".into(),
        "EnterPlanMode" => "Planning".into(),
        "NotebookEdit" => "Editing notebook".into(),
        _ => format!("Using {}", tool_name),
    }
}

pub fn process_transcript_line(
    agent_id: u32,
    line: &str,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    waiting_timers: TimerMap,
    permission_timers: TimerMap,
    app: &AppHandle,
) {
    let record: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    let record_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match record_type {
        "assistant" => {
            let content = record
                .pointer("/message/content")
                .and_then(|v| v.as_array());
            let Some(blocks) = content else { return };

            let has_tool_use = blocks.iter().any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_use"));

            if has_tool_use {
                cancel_timer(agent_id, &waiting_timers);
                {
                    let mut agents_lock = agents.lock().unwrap();
                    if let Some(agent) = agents_lock.get_mut(&agent_id) {
                        agent.is_waiting = false;
                        agent.had_tools_in_turn = true;
                    }
                }
                let _ = app.emit("backend-event", serde_json::json!({
                    "type": "agentStatus", "id": agent_id, "status": "active",
                }));

                let exempt = exempt_tools();
                let mut has_non_exempt = false;

                for block in blocks {
                    if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let Some(tool_id) = block.get("id").and_then(|v| v.as_str()) else { continue };
                    let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                    let status = format_tool_status(tool_name, &input);

                    {
                        let mut agents_lock = agents.lock().unwrap();
                        if let Some(agent) = agents_lock.get_mut(&agent_id) {
                            agent.active_tool_ids.insert(tool_id.to_string());
                            agent.active_tool_statuses.insert(tool_id.to_string(), status.clone());
                            agent.active_tool_names.insert(tool_id.to_string(), tool_name.to_string());
                        }
                    }

                    if !exempt.contains(tool_name) {
                        has_non_exempt = true;
                    }

                    let _ = app.emit("backend-event", serde_json::json!({
                        "type": "agentToolStart",
                        "id": agent_id,
                        "toolId": tool_id,
                        "status": status,
                    }));
                }

                if has_non_exempt {
                    start_permission_timer(agent_id, agents.clone(), permission_timers.clone(), app.clone());
                }
            } else {
                let has_text = blocks.iter().any(|b| b.get("type").and_then(|v| v.as_str()) == Some("text"));
                let had_tools = agents.lock().unwrap()
                    .get(&agent_id)
                    .map(|a| a.had_tools_in_turn)
                    .unwrap_or(false);

                if has_text && !had_tools {
                    start_waiting_timer(agent_id, TEXT_IDLE_DELAY_MS, agents.clone(), waiting_timers.clone(), app.clone());
                }
            }
        }

        "progress" => {
            process_progress_record(agent_id, &record, agents, waiting_timers, permission_timers, app);
        }

        "user" => {
            let content = record.pointer("/message/content");

            if let Some(arr) = content.and_then(|v| v.as_array()) {
                let has_tool_result = arr.iter().any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_result"));

                if has_tool_result {
                    for block in arr {
                        if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let Some(tool_use_id) = block.get("tool_use_id").and_then(|v| v.as_str()) else { continue };
                        let completed_id = tool_use_id.to_string();

                        // Check if completed tool is a Task and clear subagent
                        let is_task = agents.lock().unwrap()
                            .get(&agent_id)
                            .and_then(|a| a.active_tool_names.get(&completed_id))
                            .map(|n| n == "Task")
                            .unwrap_or(false);

                        if is_task {
                            if let Some(agent) = agents.lock().unwrap().get_mut(&agent_id) {
                                agent.active_subagent_tool_ids.remove(&completed_id);
                                agent.active_subagent_tool_names.remove(&completed_id);
                            }
                            let _ = app.emit("backend-event", serde_json::json!({
                                "type": "subagentClear",
                                "id": agent_id,
                                "parentToolId": completed_id,
                            }));
                        }

                        {
                            let mut agents_lock = agents.lock().unwrap();
                            if let Some(agent) = agents_lock.get_mut(&agent_id) {
                                agent.active_tool_ids.remove(&completed_id);
                                agent.active_tool_statuses.remove(&completed_id);
                                agent.active_tool_names.remove(&completed_id);
                            }
                        }

                        let app_clone = app.clone();
                        let tid = completed_id.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(TOOL_DONE_DELAY_MS)).await;
                            let _ = app_clone.emit("backend-event", serde_json::json!({
                                "type": "agentToolDone",
                                "id": agent_id,
                                "toolId": tid,
                            }));
                        });
                    }

                    // Check if all tools completed
                    let all_done = agents.lock().unwrap()
                        .get(&agent_id)
                        .map(|a| a.active_tool_ids.is_empty())
                        .unwrap_or(true);
                    if all_done {
                        if let Some(agent) = agents.lock().unwrap().get_mut(&agent_id) {
                            agent.had_tools_in_turn = false;
                        }
                    }
                } else {
                    // New user text prompt
                    cancel_timer(agent_id, &waiting_timers);
                    {
                        let mut agents_lock = agents.lock().unwrap();
                        if let Some(agent) = agents_lock.get_mut(&agent_id) {
                            clear_agent_activity(agent, agent_id, &permission_timers, app);
                            agent.had_tools_in_turn = false;
                        }
                    }
                }
            } else if content.and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                // User text string prompt
                cancel_timer(agent_id, &waiting_timers);
                {
                    let mut agents_lock = agents.lock().unwrap();
                    if let Some(agent) = agents_lock.get_mut(&agent_id) {
                        clear_agent_activity(agent, agent_id, &permission_timers, app);
                        agent.had_tools_in_turn = false;
                    }
                }
            }
        }

        "system" => {
            if record.get("subtype").and_then(|v| v.as_str()) == Some("turn_duration") {
                cancel_timer(agent_id, &waiting_timers);
                cancel_timer(agent_id, &permission_timers);

                {
                    let mut agents_lock = agents.lock().unwrap();
                    if let Some(agent) = agents_lock.get_mut(&agent_id) {
                        if !agent.active_tool_ids.is_empty() {
                            agent.active_tool_ids.clear();
                            agent.active_tool_statuses.clear();
                            agent.active_tool_names.clear();
                            agent.active_subagent_tool_ids.clear();
                            agent.active_subagent_tool_names.clear();
                            let _ = app.emit("backend-event", serde_json::json!({
                                "type": "agentToolsClear", "id": agent_id,
                            }));
                        }
                        agent.is_waiting = true;
                        agent.permission_sent = false;
                        agent.had_tools_in_turn = false;
                    }
                }

                let _ = app.emit("backend-event", serde_json::json!({
                    "type": "agentStatus", "id": agent_id, "status": "waiting",
                }));
            }
        }

        _ => {}
    }
}

fn process_progress_record(
    agent_id: u32,
    record: &serde_json::Value,
    agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    _waiting_timers: TimerMap,
    permission_timers: TimerMap,
    app: &AppHandle,
) {
    let parent_tool_id = match record.get("parentToolUseID").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let data = match record.get("data") {
        Some(d) => d,
        None => return,
    };

    let data_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // bash_progress / mcp_progress: restart permission timer
    if data_type == "bash_progress" || data_type == "mcp_progress" {
        let has_tool = agents.lock().unwrap()
            .get(&agent_id)
            .map(|a| a.active_tool_ids.contains(&parent_tool_id))
            .unwrap_or(false);
        if has_tool {
            start_permission_timer(agent_id, agents.clone(), permission_timers.clone(), app.clone());
        }
        return;
    }

    // Verify parent is a Task tool
    let is_task = agents.lock().unwrap()
        .get(&agent_id)
        .and_then(|a| a.active_tool_names.get(&parent_tool_id).cloned())
        .map(|n| n == "Task")
        .unwrap_or(false);
    if !is_task { return; }

    let msg = match data.get("message") {
        Some(m) => m,
        None => return,
    };
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let content = match msg.pointer("/message/content").and_then(|v| v.as_array()) {
        Some(c) => c,
        None => return,
    };

    let exempt = exempt_tools();

    if msg_type == "assistant" {
        let mut has_non_exempt = false;
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") { continue; }
            let Some(tool_id) = block.get("id").and_then(|v| v.as_str()) else { continue };
            let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
            let status = format_tool_status(tool_name, &input);

            {
                let mut agents_lock = agents.lock().unwrap();
                if let Some(agent) = agents_lock.get_mut(&agent_id) {
                    agent.active_subagent_tool_ids
                        .entry(parent_tool_id.clone())
                        .or_default()
                        .insert(tool_id.to_string());
                    agent.active_subagent_tool_names
                        .entry(parent_tool_id.clone())
                        .or_default()
                        .insert(tool_id.to_string(), tool_name.to_string());
                }
            }

            if !exempt.contains(tool_name) {
                has_non_exempt = true;
            }

            let _ = app.emit("backend-event", serde_json::json!({
                "type": "subagentToolStart",
                "id": agent_id,
                "parentToolId": parent_tool_id,
                "toolId": tool_id,
                "status": status,
            }));
        }

        if has_non_exempt {
            start_permission_timer(agent_id, agents.clone(), permission_timers.clone(), app.clone());
        }
    } else if msg_type == "user" {
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") { continue; }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(|v| v.as_str()) else { continue };

            {
                let mut agents_lock = agents.lock().unwrap();
                if let Some(agent) = agents_lock.get_mut(&agent_id) {
                    if let Some(sub_tools) = agent.active_subagent_tool_ids.get_mut(&parent_tool_id) {
                        sub_tools.remove(tool_use_id);
                    }
                    if let Some(sub_names) = agent.active_subagent_tool_names.get_mut(&parent_tool_id) {
                        sub_names.remove(tool_use_id);
                    }
                }
            }

            let app_clone = app.clone();
            let ptid = parent_tool_id.clone();
            let tid = tool_use_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let _ = app_clone.emit("backend-event", serde_json::json!({
                    "type": "subagentToolDone",
                    "id": agent_id,
                    "parentToolId": ptid,
                    "toolId": tid,
                }));
            });
        }

        // Check for remaining non-exempt sub-agent tools
        let still_has = agents.lock().unwrap()
            .get(&agent_id)
            .map(|a| {
                a.active_subagent_tool_names.values().any(|sub| {
                    sub.values().any(|name| !exempt.contains(name.as_str()))
                })
            })
            .unwrap_or(false);
        if still_has {
            start_permission_timer(agent_id, agents.clone(), permission_timers.clone(), app.clone());
        }
    }
}
