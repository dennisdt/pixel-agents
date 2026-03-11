use std::collections::HashMap;
use std::time::Duration;
use tokio::process::Command;

const OSASCRIPT_TIMEOUT_MS: u64 = 5000;

/// Read all Terminal.app tab screen contents in a single osascript call.
///
/// Uses JXA (JavaScript for Automation) instead of AppleScript because JXA
/// handles Unicode string concatenation reliably — AppleScript fails on tabs
/// whose `contents` include certain Unicode characters.
///
/// Uses `contents` (visible screen snapshot) instead of `history` (raw scrollback)
/// because Claude Code is a full-screen TUI — `contents` gives clean text without
/// ANSI escape sequences, similar to tmux's `capture-pane -p`.
///
/// Returns a map of tty_path -> screen_text.
pub async fn read_all_terminal_contents() -> HashMap<String, String> {
    let script = r#"
const terminal = Application("Terminal");
const results = [];
try {
  const windows = terminal.windows();
  for (let w of windows) {
    const tabs = w.tabs();
    for (let t of tabs) {
      try {
        const tty = t.tty();
        const contents = t.contents();
        results.push(tty + "|" + contents);
      } catch(e) {}
    }
  }
} catch(e) {}
results.join("<<<SEP>>>");
"#;

    let result = tokio::time::timeout(
        Duration::from_millis(OSASCRIPT_TIMEOUT_MS),
        Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg(script)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return HashMap::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();

    for entry in stdout.split("<<<SEP>>>") {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some(pipe_pos) = entry.find('|') {
            let tty_path = entry[..pipe_pos].trim().to_string();
            let content = &entry[pipe_pos + 1..];
            if !tty_path.is_empty() {
                map.insert(tty_path, content.to_string());
            }
        }
    }

    map
}
