pub mod jsonl_subagent;
pub mod parser;
pub mod reader;

use std::path::Path;

/// Hash a filesystem path the same way Claude does: replace non-alphanumeric/hyphen chars with `-`.
pub fn hash_path(p: &Path) -> String {
    p.to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}
