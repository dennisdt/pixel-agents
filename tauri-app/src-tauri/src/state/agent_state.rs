use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub struct AgentState {
    pub id: u32,
    pub session_id: String,
    pub project_dir: PathBuf,
    pub jsonl_file: Option<PathBuf>,
    pub file_offset: u64,
    pub line_buffer: String,
    pub active_tool_ids: HashSet<String>,
    pub active_tool_statuses: HashMap<String, String>,
    pub active_tool_names: HashMap<String, String>,
    pub active_subagent_tool_ids: HashMap<String, HashSet<String>>,
    pub active_subagent_tool_names: HashMap<String, HashMap<String, String>>,
    pub is_waiting: bool,
    pub permission_sent: bool,
    pub had_tools_in_turn: bool,
    pub palette: u32,
    pub hue_shift: f64,
    pub seat_id: Option<String>,
    pub terminal_index: u32,
    pub folder_name: Option<String>,
    pub is_external: bool,
}

impl AgentState {
    pub fn new(id: u32, session_id: String, project_dir: PathBuf, terminal_index: u32) -> Self {
        Self {
            id,
            session_id,
            project_dir,
            jsonl_file: None,
            file_offset: 0,
            line_buffer: String::new(),
            active_tool_ids: HashSet::new(),
            active_tool_statuses: HashMap::new(),
            active_tool_names: HashMap::new(),
            active_subagent_tool_ids: HashMap::new(),
            active_subagent_tool_names: HashMap::new(),
            is_waiting: false,
            permission_sent: false,
            had_tools_in_turn: false,
            palette: 0,
            hue_shift: 0.0,
            seat_id: None,
            terminal_index,
            folder_name: None,
            is_external: false,
        }
    }
}
