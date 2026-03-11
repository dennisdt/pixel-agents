use std::collections::HashMap;
use std::time::Instant;

use crate::tty::jsonl_subagent::JsonlReader;
use crate::tty::parser::AgentActivity;

#[allow(dead_code)]
pub struct AgentState {
    pub id: u32,
    pub session_id: String,
    pub project_dir: std::path::PathBuf,
    pub terminal_index: u32,
    // Webview state (set by Rust, read by webview via events)
    pub palette: u32,
    pub hue_shift: f64,
    pub seat_id: Option<String>,
    pub folder_name: Option<String>,
    pub is_external: bool,
    pub created_at: Instant,
    pub pid: Option<u32>,
    pub tty: Option<String>,
    pub cwd: Option<String>,
    // TTY parsing state
    pub last_content_hash: u64,
    pub stale_count: u32,
    pub last_activity: Option<AgentActivity>,
    // JSONL tool tracking (primary + sub-agent)
    pub jsonl_reader: Option<JsonlReader>,
    pub active_subagent_tool_names: HashMap<String, HashMap<String, String>>,
}

impl AgentState {
    pub fn new(
        id: u32,
        session_id: String,
        project_dir: std::path::PathBuf,
        terminal_index: u32,
    ) -> Self {
        Self {
            id,
            session_id,
            project_dir,
            terminal_index,
            palette: 0,
            hue_shift: 0.0,
            seat_id: None,
            folder_name: None,
            is_external: false,
            created_at: Instant::now(),
            pid: None,
            tty: None,
            cwd: None,
            last_content_hash: 0,
            stale_count: 0,
            last_activity: None,
            jsonl_reader: None,
            active_subagent_tool_names: HashMap::new(),
        }
    }
}
