/// Parser variant used to interpret the stdout of a model-listing command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelParser {
    Lines,
    Aider,
    Cursor,
}

/// Static description of an AI coding agent.
#[derive(Debug)]
pub struct AgentSpec {
    pub name: &'static str,
    pub binaries: &'static [&'static str],
    pub cmd_template: &'static str,
    pub model_cmd: Option<&'static [&'static str]>,
    pub known_models: &'static [&'static str],
    pub parser: ModelParser,
}

pub static AGENTS: &[AgentSpec] = &[
    AgentSpec {
        name: "Claude Code",
        binaries: &["claude"],
        cmd_template: "claude -p --dangerously-skip-permissions --model {model} {message}",
        model_cmd: None,
        known_models: &[
            "claude-sonnet-4-5",
            "claude-opus-4",
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-5",
        ],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "Codex",
        binaries: &["codex"],
        cmd_template: "codex exec --json --full-auto -m {model} {message}",
        model_cmd: None,
        known_models: &["o4-mini", "o3", "gpt-4.1", "codex-mini"],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "OpenCode",
        binaries: &["opencode"],
        cmd_template: "opencode run --thinking --model {model} {message}",
        model_cmd: Some(&["opencode", "models"]),
        known_models: &[],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "KiloCode",
        binaries: &["kilocode", "kilo"],
        cmd_template: "kilocode run --auto --thinking --model {model} {message}",
        model_cmd: Some(&["kilocode", "models"]),
        known_models: &[],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "Aider",
        binaries: &["aider"],
        cmd_template: "aider --yes-always --model {model} --message {message}",
        model_cmd: Some(&["aider", "--list-models", "*"]),
        known_models: &[],
        parser: ModelParser::Aider,
    },
    AgentSpec {
        name: "Cursor Agent",
        binaries: &["agent"],
        cmd_template: "agent --print --force --trust --model {model} {message}",
        model_cmd: Some(&["agent", "models"]),
        known_models: &[],
        parser: ModelParser::Cursor,
    },
];

/// Strip ANSI escape sequences from a string.
pub fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\x1b' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip ESC [
            i += 2;
            // Skip parameter bytes (0x30–0x3F) and intermediate bytes (0x20–0x2F)
            while i < bytes.len() && (bytes[i] >= 0x20 && bytes[i] <= 0x3F) {
                i += 1;
            }
            // Skip final byte (0x40–0x7E)
            if i < bytes.len() && bytes[i] >= 0x40 && bytes[i] <= 0x7E {
                i += 1;
            }
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }
    result
}

const SKIP_PREFIXES: &[&str] = &[
    "available",
    "models",
    "loading",
    "fetching",
    "tip:",
];

/// Default line-by-line parser: strips ANSI, skips blank lines and known header prefixes.
pub fn parse_lines(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l).trim().to_owned())
        .filter(|l| {
            if l.is_empty() {
                return false;
            }
            let lower = l.to_lowercase();
            !SKIP_PREFIXES.iter().any(|p| lower.starts_with(p))
        })
        .collect()
}

/// Aider parser: extracts lines that start with "- ".
pub fn parse_aider(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l))
        .filter_map(|l| {
            let trimmed = l.trim();
            trimmed.strip_prefix("- ").map(|s| s.trim().to_owned())
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Cursor parser: strips "(current)"/"(default)" annotations and takes the part before " - ".
pub fn parse_cursor(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l))
        .filter_map(|l| {
            let trimmed = l.trim();
            if trimmed.is_empty() {
                return None;
            }
            let cleaned = trimmed
                .replace("(current)", "")
                .replace("(default)", "")
                .trim()
                .to_owned();
            if cleaned.is_empty() {
                return None;
            }
            // Take the part before " - " if present
            let model_part = cleaned
                .split(" - ")
                .next()
                .unwrap_or(&cleaned)
                .trim()
                .to_owned();
            if model_part.is_empty() {
                None
            } else {
                Some(model_part)
            }
        })
        .collect()
}

/// Dispatch to the correct parser based on the `ModelParser` variant.
pub fn parse_models(parser: ModelParser, stdout: &str) -> Vec<String> {
    match parser {
        ModelParser::Lines => parse_lines(stdout),
        ModelParser::Aider => parse_aider(stdout),
        ModelParser::Cursor => parse_cursor(stdout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_six_agents() {
        assert_eq!(AGENTS.len(), 6);
    }

    #[test]
    fn test_claude_code_has_known_models() {
        let claude = AGENTS.iter().find(|a| a.name == "Claude Code").unwrap();
        assert!(claude.known_models.contains(&"claude-sonnet-4-5"));
        assert!(claude.known_models.contains(&"claude-opus-4"));
        assert!(claude.known_models.contains(&"claude-sonnet-4-6"));
        assert!(claude.known_models.contains(&"claude-opus-4-6"));
        assert!(claude.known_models.contains(&"claude-haiku-4-5"));
        assert_eq!(claude.known_models.len(), 5);
    }

    #[test]
    fn test_kilocode_has_model_cmd() {
        let kilo = AGENTS.iter().find(|a| a.name == "KiloCode").unwrap();
        assert!(kilo.model_cmd.is_some());
        let cmd = kilo.model_cmd.unwrap();
        assert_eq!(cmd[0], "kilocode");
        assert_eq!(cmd[1], "models");
    }

    #[test]
    fn test_all_agents_have_cmd_template_with_placeholders() {
        for agent in AGENTS {
            assert!(
                agent.cmd_template.contains("{model}"),
                "Agent '{}' cmd_template missing {{model}} placeholder",
                agent.name
            );
            assert!(
                agent.cmd_template.contains("{message}"),
                "Agent '{}' cmd_template missing {{message}} placeholder",
                agent.name
            );
        }
    }

    #[test]
    fn test_parse_lines_strips_ansi_and_headers() {
        let input = "\x1b[32mAvailable models:\x1b[0m\n\x1b[1mgpt-4\x1b[0m\nclaude-3\nLoading...\n\nfetching list\ntip: use --model flag\n";
        let result = parse_lines(input);
        // Should include "gpt-4" and "claude-3" but not the header/blank lines
        assert!(result.contains(&"gpt-4".to_owned()), "Expected gpt-4 in result: {:?}", result);
        assert!(result.contains(&"claude-3".to_owned()), "Expected claude-3 in result: {:?}", result);
        // Headers should be excluded
        for item in &result {
            let lower = item.to_lowercase();
            assert!(!lower.starts_with("available"), "Should not contain 'available' header");
            assert!(!lower.starts_with("loading"), "Should not contain 'loading' header");
            assert!(!lower.starts_with("fetching"), "Should not contain 'fetching' header");
            assert!(!lower.starts_with("tip:"), "Should not contain 'tip:' header");
        }
    }

    #[test]
    fn test_parse_aider_extracts_dashed_lines() {
        let input = "Available models:\n- gpt-4\n- claude-3\nSome other line\n- o3-mini\n";
        let result = parse_aider(input);
        assert_eq!(result, vec!["gpt-4", "claude-3", "o3-mini"]);
    }
}
