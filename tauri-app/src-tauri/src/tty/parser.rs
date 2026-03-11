use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

const BASH_CMD_MAX: usize = 30;
const TASK_DESC_MAX: usize = 40;

/// Claude Code TUI sentinel: present only when Claude is actively processing.
pub const ACTIVE_SENTINEL: &str = "esc to interrupt";
/// Claude Code TUI sentinel: permission prompt with reject option.
const PERMISSION_SENTINEL: &str = "No, and tell Claude what to do differently";

fn re_permission() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Allow\s+([\w][\w:.\-]*)\((.{0,200}?)\)\?").unwrap())
}

fn re_tool() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^⏺\s+([\w][\w:.\-]*)\((.{0,500}?)\)\s*$").unwrap())
}

fn re_thinking() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Matches thinking indicators:
    // - "· Thinking…", "· Envisioning…" (middle dot U+00B7)
    // - Braille spinner chars (U+2800-28FF) followed by text
    // - "✶ Mulling…" (six-pointed star U+2736, active thinking)
    RE.get_or_init(|| Regex::new(r"^[·✶\u{2800}-\u{28FF}]\s+\S").unwrap())
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentActivity {
    Waiting,
    Thinking,
    ToolActive { tool_name: String, args: String },
    PermissionNeeded { tool_name: String },
    Unknown,
}

/// Parse terminal screen contents to detect the current agent state.
///
/// Designed for Terminal.app `contents` (visible screen snapshot), which gives
/// clean text without ANSI escapes — similar to tmux's `capture-pane -p`.
///
/// Claude Code's TUI always shows the `❯` input prompt as part of its frame,
/// so the primary active/idle signal is **"esc to interrupt"** in the status bar
/// (present only when Claude is actively running). Line-by-line scanning above
/// the TUI chrome determines the specific tool/thinking state.
pub fn parse_terminal_state(text: &str) -> AgentActivity {
    // Phase 1: Global signal checks (inspired by claude-squad's simple string matching)

    // Permission prompt — claude-squad style literal match + regex for tool name
    if text.contains(PERMISSION_SENTINEL) {
        if let Some(caps) = re_permission().captures_iter(text).last() {
            return AgentActivity::PermissionNeeded {
                tool_name: caps[1].to_string(),
            };
        }
        return AgentActivity::PermissionNeeded {
            tool_name: "Unknown".into(),
        };
    }

    // "esc to interrupt" = Claude is actively running
    let is_active = text.contains(ACTIVE_SENTINEL);

    // Phase 2: Line-by-line scan for specific state (bottom-to-top, skip TUI chrome)
    let lines: Vec<&str> = text.lines().collect();

    for line in lines.iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if is_tui_chrome(trimmed) {
            continue;
        }

        // The ❯ prompt is always part of Claude's TUI frame — skip it
        if trimmed.starts_with('❯') {
            continue;
        }

        // Permission prompt regex (backup for cases without the literal string)
        if let Some(caps) = re_permission().captures(trimmed) {
            return AgentActivity::PermissionNeeded {
                tool_name: caps[1].to_string(),
            };
        }

        // Completion marker — "✻ ..." (teardrop asterisk, turn cost line = done)
        if trimmed.starts_with('✻') {
            return AgentActivity::Waiting;
        }

        // Thinking spinner — "· Thinking…", "✶ Mulling…", braille chars
        if re_thinking().is_match(trimmed) {
            return AgentActivity::Thinking;
        }

        // Tool call — "⏺ ToolName(args)"
        if let Some(caps) = re_tool().captures(trimmed) {
            return AgentActivity::ToolActive {
                tool_name: caps[1].to_string(),
                args: caps[2].to_string(),
            };
        }

        // Tool text output — "⏺ <text>" (no parens, e.g. "⏺ Let me verify...")
        if trimmed.starts_with('⏺') {
            return AgentActivity::Thinking;
        }

        // Result indicator — "⎿ <result text>" (U+23BF) means tool output
        if trimmed.starts_with('\u{23BF}') {
            return AgentActivity::Thinking;
        }

        // Non-marker content line — use the global active signal
        if is_active {
            return AgentActivity::Thinking;
        }

        // Not active and no recognized marker — waiting
        return AgentActivity::Waiting;
    }

    // Fallback: use global active signal
    if is_active {
        AgentActivity::Thinking
    } else {
        AgentActivity::Unknown
    }
}

/// Check if a line is TUI chrome that should be skipped during parsing.
fn is_tui_chrome(line: &str) -> bool {
    let first = match line.chars().next() {
        Some(c) => c,
        None => return true,
    };

    // Box-drawing characters (U+2500-U+257F)
    if ('\u{2500}'..='\u{257F}').contains(&first) {
        return true;
    }

    // Status bar indicators: ⏵ (U+23F5), ⏸ (U+23F8 plan mode)
    if first == '\u{23F5}' || first == '\u{23F8}' {
        return true;
    }

    // Status bar content (may have leading spaces)
    if line.contains("shift+tab to cycle") || line.contains(ACTIVE_SENTINEL) {
        return true;
    }

    // Lines of only box-drawing chars, spaces, and decorators
    if line.chars().all(|c| {
        c == ' '
            || ('\u{2500}'..='\u{257F}').contains(&c)
            || c == '\u{25AA}' // ▪
    }) {
        return true;
    }

    false
}

/// Truncate a string to at most `max_chars` characters (not bytes).
fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

/// Extract just the file name from a path string, falling back to the full string.
fn file_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Generate a status string from AgentActivity that matches webview-ui toolUtils.ts STATUS_TO_TOOL.
pub fn format_tool_status(activity: &AgentActivity) -> Option<String> {
    match activity {
        AgentActivity::ToolActive { tool_name, args } => {
            let status = match tool_name.as_str() {
                "Read" => format!("Reading {}", file_basename(args)),
                "Edit" => format!("Editing {}", file_basename(args)),
                "Write" => format!("Writing {}", file_basename(args)),
                "Bash" => {
                    let truncated = truncate_chars(args, BASH_CMD_MAX);
                    if truncated.len() < args.len() {
                        format!("Running: {}\u{2026}", truncated)
                    } else {
                        format!("Running: {}", args)
                    }
                }
                "Glob" => "Searching files".into(),
                "Grep" => "Searching code".into(),
                "WebFetch" => "Fetching web content".into(),
                "WebSearch" => "Searching the web".into(),
                "Task" => {
                    if args.is_empty() {
                        "Running subtask".into()
                    } else {
                        let truncated = truncate_chars(args, TASK_DESC_MAX);
                        if truncated.len() < args.len() {
                            format!("Subtask: {}\u{2026}", truncated)
                        } else {
                            format!("Subtask: {}", args)
                        }
                    }
                }
                "AskUserQuestion" => "Waiting for your answer".into(),
                "EnterPlanMode" => "Planning".into(),
                "NotebookEdit" => "Editing notebook".into(),
                _ => format!("Using {}", tool_name),
            };
            Some(status)
        }
        _ => None,
    }
}

/// Hash the full content for staleness detection.
pub fn content_fingerprint(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Waiting states ---

    #[test]
    fn test_waiting_on_cost_line() {
        let text = "some output\n✻ Tokens: 18.2k input  Cost: $0.06  Duration: 8s for 1 query\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Waiting);
    }

    #[test]
    fn test_waiting_on_crunched_line() {
        let text = "some output\n✻ Crunched for 5m 24s\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Waiting);
    }

    #[test]
    fn test_waiting_idle_prompt_no_esc() {
        // Idle Claude: ❯ visible, no "esc to interrupt" — waiting
        let text = "some output\n───── ▪▪▪ ─\n❯ \n─────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Waiting);
    }

    #[test]
    fn test_waiting_cost_line_with_chrome_below() {
        let text = "✻ Crunched for 5m 24s\n────────────────── ▪▪▪ ─\n❯\n─────────────────────\n  ⏵⏵ bypass permissions on\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Waiting);
    }

    // --- Active/thinking states ---

    #[test]
    fn test_thinking_with_middle_dot() {
        let text = "· Envisioning\u{2026} (5m 18s)\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    #[test]
    fn test_thinking_with_mulling_star() {
        // ✶ (U+2736) = active thinking indicator (different from ✻ = completed)
        let text = "✶ Mulling\u{2026} (7m 45s)\n───── ▪▪▪ ─\n❯\n─────────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    #[test]
    fn test_thinking_text_output() {
        let text = "⏺ Let me verify nothing else references the old field names.\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    #[test]
    fn test_active_with_esc_to_interrupt() {
        // "esc to interrupt" present + non-marker content = active/thinking
        let text = "Some regular output text\n───── ▪▪▪ ─\n❯\n─────────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    #[test]
    fn test_tool_result_indicator() {
        let text = "⏺ Bash(cargo build)\n  \u{23BF} \u{00A0}Building...\n────────────────────\n  ⏵⏵ bypass permissions on\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    // --- Tool active states ---

    #[test]
    fn test_tool_active() {
        let text = "⏺ Read(src/main.rs)\n";
        assert_eq!(
            parse_terminal_state(text),
            AgentActivity::ToolActive {
                tool_name: "Read".into(),
                args: "src/main.rs".into(),
            }
        );
    }

    #[test]
    fn test_tool_active_real_tui() {
        // Real TUI output: tool call above separator and prompt
        let text = "⏺ Read(src/main.rs)\n  \u{23BF} file content...\n───── ▪▪▪ ─\n❯\n─────────────────────\n  ⏵⏵ bypass permissions on · esc to interrupt\n";
        assert_eq!(parse_terminal_state(text), AgentActivity::Thinking);
    }

    // --- Permission states ---

    #[test]
    fn test_permission_needed_regex() {
        let text = "  Allow Bash(npm test)? (y/n/A)\n";
        assert_eq!(
            parse_terminal_state(text),
            AgentActivity::PermissionNeeded {
                tool_name: "Bash".into(),
            }
        );
    }

    #[test]
    fn test_permission_claude_squad_style() {
        // claude-squad detects this literal string
        let text = "Allow Bash(rm -rf)?\n  Yes\n  No, and tell Claude what to do differently\n";
        assert_eq!(
            parse_terminal_state(text),
            AgentActivity::PermissionNeeded {
                tool_name: "Bash".into(),
            }
        );
    }

    // --- Format tool status ---

    #[test]
    fn test_format_tool_status_read() {
        let activity = AgentActivity::ToolActive {
            tool_name: "Read".into(),
            args: "/some/path/file.rs".into(),
        };
        assert_eq!(format_tool_status(&activity), Some("Reading file.rs".into()));
    }

    // --- Fingerprint ---

    #[test]
    fn test_content_fingerprint_same() {
        let a = content_fingerprint("hello world");
        let b = content_fingerprint("hello world");
        assert_eq!(a, b);
    }

    #[test]
    fn test_content_fingerprint_different() {
        let a = content_fingerprint("hello world");
        let b = content_fingerprint("hello world!");
        assert_ne!(a, b);
    }

    // --- TUI chrome detection ---

    #[test]
    fn test_tui_chrome_detection() {
        assert!(is_tui_chrome("────────────────────────────"));
        assert!(is_tui_chrome("⏵⏵ bypass permissions on (shift+tab to cycle)"));
        assert!(is_tui_chrome("⏸ plan mode on (shift+tab to cycle)"));
        assert!(is_tui_chrome("──────────── ▪▪▪ ─"));
        assert!(is_tui_chrome("  ⏵⏵ bypass permissions on · esc to interrupt"));
        assert!(!is_tui_chrome("⏺ Read(file.rs)"));
        assert!(!is_tui_chrome("✻ Crunched for 5m"));
        assert!(!is_tui_chrome("Allow Bash(test)?"));
    }
}
