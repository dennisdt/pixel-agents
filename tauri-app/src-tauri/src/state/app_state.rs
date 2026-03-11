use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::agent_state::AgentState;

pub struct AppState {
    pub agents: Arc<Mutex<HashMap<u32, AgentState>>>,
    pub next_agent_id: Arc<Mutex<u32>>,
    pub next_terminal_index: Arc<Mutex<u32>>,
    pub known_pids: Arc<Mutex<HashSet<u32>>>,
    pub assets_root: Mutex<Option<PathBuf>>,
    pub layout_skip_flag: Arc<AtomicBool>,
    pub project_hash: Mutex<Option<String>>,
    pub global_scan_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            next_agent_id: Arc::new(Mutex::new(1)),
            next_terminal_index: Arc::new(Mutex::new(1)),
            known_pids: Arc::new(Mutex::new(HashSet::new())),
            assets_root: Mutex::new(None),
            layout_skip_flag: Arc::new(AtomicBool::new(false)),
            project_hash: Mutex::new(None),
            global_scan_handle: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
