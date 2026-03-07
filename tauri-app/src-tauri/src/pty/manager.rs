use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_pty(
        &self,
        agent_id: u32,
        cwd: &str,
        session_id: &str,
        app: AppHandle,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(Path::new(cwd));

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {}", e))?;

        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        // Send claude command (unset inherited env vars to avoid "nested session" error)
        let claude_cmd = format!("unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; claude --session-id {}\n", session_id);
        writer
            .write_all(claude_cmd.as_bytes())
            .map_err(|e| format!("Failed to write: {}", e))?;

        // Start reading PTY output in background
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let app_clone = app;
        let agent_id_clone = agent_id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_clone.emit(
                            &format!("pty-output-{}", agent_id_clone),
                            serde_json::json!({ "data": data }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let session = PtySession {
            master: pair.master,
            writer,
            _child: child,
        };

        self.sessions.lock().unwrap().insert(agent_id, session);
        Ok(())
    }

    pub fn write_pty(&self, agent_id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&agent_id)
            .ok_or_else(|| format!("No PTY for agent {}", agent_id))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize_pty(&self, agent_id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&agent_id)
            .ok_or_else(|| format!("No PTY for agent {}", agent_id))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn close_pty(&self, agent_id: u32) {
        self.sessions.lock().unwrap().remove(&agent_id);
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
