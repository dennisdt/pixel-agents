use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::parser;

/// Events from JSONL records — both primary agent tools and subagent progress.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum JsonlEvent {
    /// Primary agent started a tool (from top-level `assistant` record).
    ToolStart {
        tool_id: String,
        tool_name: String,
        status: String,
    },
    /// Primary agent tool completed (from top-level `user` record with tool_result).
    ToolDone {
        tool_id: String,
    },
    /// Agent turn ended (from `system` record with `subtype: "turn_duration"`).
    TurnEnd,
    /// Subagent started a tool (from `progress` record with `data.type: "agent_progress"`).
    SubagentToolStart {
        parent_tool_id: String,
        tool_id: String,
        tool_name: String,
        status: String,
    },
    /// Subagent tool completed.
    SubagentToolDone {
        parent_tool_id: String,
        tool_id: String,
    },
    /// Token usage from an assistant response.
    TokenUsage {
        output_tokens: u64,
    },
}

pub struct JsonlReader {
    file_offset: u64,
    line_buffer: String,
    /// The JSONL file currently being read (tracks changes from `/clear`).
    current_file: Option<PathBuf>,
}

impl JsonlReader {
    pub fn new() -> Self {
        Self {
            file_offset: 0,
            line_buffer: String::new(),
            current_file: None,
        }
    }

    /// Read new events, auto-discovering the latest JSONL file in `project_dir`.
    /// If the active file changes (e.g., after `/clear`), resets to read the new file from the start.
    pub fn read_events_from_project(&mut self, project_dir: &Path) -> Vec<JsonlEvent> {
        let target = match find_latest_jsonl(project_dir) {
            Some(p) => p,
            None => return vec![],
        };

        // Detect file change (new session or /clear)
        if self.current_file.as_ref() != Some(&target) {
            if self.current_file.is_some() {
                // File changed — reset to read new file from start
                self.file_offset = 0;
                self.line_buffer.clear();
            } else {
                // First time — seek to end so we only read new records
                if let Ok(stat) = std::fs::metadata(&target) {
                    self.file_offset = stat.len();
                }
            }
            self.current_file = Some(target.clone());
        }

        self.read_events(&target)
    }

    /// Read new records from the JSONL file since last offset.
    fn read_events(&mut self, jsonl_path: &Path) -> Vec<JsonlEvent> {
        let stat = match std::fs::metadata(jsonl_path) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let file_size = stat.len();
        if file_size <= self.file_offset {
            return vec![];
        }

        let mut file = match File::open(jsonl_path) {
            Ok(f) => f,
            Err(_) => return vec![],
        };

        if file.seek(SeekFrom::Start(self.file_offset)).is_err() {
            return vec![];
        }

        let bytes_to_read = (file_size - self.file_offset) as usize;
        let mut buf = vec![0u8; bytes_to_read];
        if file.read_exact(&mut buf).is_err() {
            return vec![];
        }

        let text = format!("{}{}", self.line_buffer, String::from_utf8_lossy(&buf));
        let mut lines: Vec<&str> = text.split('\n').collect();
        let remaining = lines.pop().unwrap_or("").to_string();

        self.file_offset = file_size;
        self.line_buffer = remaining;

        let mut events = Vec::new();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            events.extend(process_line(line));
        }
        events
    }
}

fn process_line(line: &str) -> Vec<JsonlEvent> {
    let record: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let record_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match record_type {
        "assistant" => process_assistant_record(&record),
        "user" => process_user_record(&record),
        "system" => process_system_record(&record),
        "progress" => process_progress_record(&record),
        _ => vec![],
    }
}

/// Extract (tool_id, tool_name, status) from tool_use blocks in a content array.
fn extract_tool_starts(content: &[serde_json::Value]) -> Vec<(String, String, String)> {
    let mut results = Vec::new();
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(tool_id) = block.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));

        let activity = parser::AgentActivity::ToolActive {
            tool_name: tool_name.to_string(),
            args: extract_tool_args(tool_name, &input),
        };
        let status = parser::format_tool_status(&activity)
            .unwrap_or_else(|| format!("Using {}", tool_name));

        results.push((tool_id.to_string(), tool_name.to_string(), status));
    }
    results
}

/// Extract tool_use_id values from tool_result blocks in a content array.
fn extract_tool_done_ids(content: &[serde_json::Value]) -> Vec<String> {
    content
        .iter()
        .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
        .filter_map(|b| b.get("tool_use_id").and_then(|v| v.as_str()).map(String::from))
        .collect()
}

/// Extract tool_use blocks and token usage from a primary `assistant` record.
fn process_assistant_record(record: &serde_json::Value) -> Vec<JsonlEvent> {
    let mut events = Vec::new();

    // Extract output_tokens from usage
    if let Some(output_tokens) = record
        .get("message")
        .and_then(|m| m.get("usage"))
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
    {
        if output_tokens > 0 {
            events.push(JsonlEvent::TokenUsage { output_tokens });
        }
    }

    // Extract tool_use blocks
    if let Some(content) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        events.extend(
            extract_tool_starts(content)
                .into_iter()
                .map(|(tool_id, tool_name, status)| JsonlEvent::ToolStart { tool_id, tool_name, status }),
        );
    }

    events
}

/// Extract tool_result blocks from a primary `user` record.
fn process_user_record(record: &serde_json::Value) -> Vec<JsonlEvent> {
    let Some(arr) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return vec![];
    };

    extract_tool_done_ids(arr)
        .into_iter()
        .map(|tool_id| JsonlEvent::ToolDone { tool_id })
        .collect()
}

/// Detect turn end from `system` records.
fn process_system_record(record: &serde_json::Value) -> Vec<JsonlEvent> {
    let subtype = record.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if subtype == "turn_duration" {
        vec![JsonlEvent::TurnEnd]
    } else {
        vec![]
    }
}

/// Extract subagent tool events from `progress` records.
fn process_progress_record(record: &serde_json::Value) -> Vec<JsonlEvent> {
    let parent_tool_id = match record.get("parentToolUseID").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return vec![],
    };

    let data = match record.get("data") {
        Some(d) => d,
        None => return vec![],
    };

    let data_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if data_type != "agent_progress" {
        return vec![];
    }

    let msg = match data.get("message") {
        Some(m) => m,
        None => return vec![],
    };
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let content = match msg.get("content").and_then(|v| v.as_array()) {
        Some(c) => c,
        None => return vec![],
    };

    if msg_type == "assistant" {
        extract_tool_starts(content)
            .into_iter()
            .map(|(tool_id, tool_name, status)| JsonlEvent::SubagentToolStart {
                parent_tool_id: parent_tool_id.clone(),
                tool_id,
                tool_name,
                status,
            })
            .collect()
    } else if msg_type == "user" {
        extract_tool_done_ids(content)
            .into_iter()
            .map(|tool_id| JsonlEvent::SubagentToolDone {
                parent_tool_id: parent_tool_id.clone(),
                tool_id,
            })
            .collect()
    } else {
        vec![]
    }
}

/// Extract the most relevant argument from a tool_use input for status display.
fn extract_tool_args(tool_name: &str, input: &serde_json::Value) -> String {
    let key = match tool_name {
        "Read" | "Edit" | "Write" => "file_path",
        "Bash" => "command",
        "Task" | "Agent" => "description",
        "Glob" | "Grep" => "pattern",
        _ => return String::new(),
    };
    input
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Find the most recently modified JSONL file in a Claude project directory.
pub fn find_latest_jsonl(project_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(project_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(mtime) = meta.modified() {
                if best.as_ref().map_or(true, |(_, t)| mtime > *t) {
                    best = Some((path, mtime));
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

