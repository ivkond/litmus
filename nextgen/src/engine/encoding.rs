/// Encodes a model name for safe use in directory/file names.
/// Encoding rules:
///   ~ → ~~
///   / → ~f
///   : → ~c
pub fn encode_model_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '~' => result.push_str("~~"),
            '/' => result.push_str("~f"),
            ':' => result.push_str("~c"),
            other => result.push(other),
        }
    }
    result
}

/// Decodes an encoded model name back to its original form.
/// Unknown escape sequences (e.g. ~x) are passed through unchanged.
pub fn decode_model_name(encoded: &str) -> String {
    let mut result = String::with_capacity(encoded.len());
    let mut chars = encoded.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '~' {
            match chars.peek() {
                Some('~') => {
                    chars.next();
                    result.push('~');
                }
                Some('f') => {
                    chars.next();
                    result.push('/');
                }
                Some('c') => {
                    chars.next();
                    result.push(':');
                }
                _ => {
                    // Unknown escape — pass tilde through, leave next char for next iteration
                    result.push('~');
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// Returns the run directory name for a given agent and model.
/// Format: `{agent}_{encoded_model}`
pub fn run_dir_name(agent: &str, model: &str) -> String {
    format!("{}_{}", agent, encode_model_name(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_simple_name() {
        assert_eq!(encode_model_name("gpt-4o"), "gpt-4o");
    }

    #[test]
    fn test_encode_slashes() {
        assert_eq!(
            encode_model_name("kilo/arcee-ai/trinity:free"),
            "kilo~farcee-ai~ftrinity~cfree"
        );
    }

    #[test]
    fn test_encode_tilde_escaped() {
        assert_eq!(encode_model_name("model~name"), "model~~name");
    }

    #[test]
    fn test_roundtrip() {
        let original = "kilo/arcee-ai/trinity~large:free";
        assert_eq!(decode_model_name(&encode_model_name(original)), original);
    }

    #[test]
    fn test_decode_plain() {
        assert_eq!(decode_model_name("gpt-4o"), "gpt-4o");
    }

    #[test]
    fn test_decode_unknown_escape() {
        assert_eq!(decode_model_name("model~xname"), "model~xname");
    }

    #[test]
    fn test_run_dir_name() {
        assert_eq!(
            run_dir_name("KiloCode", "kilo/model:free"),
            "KiloCode_kilo~fmodel~cfree"
        );
    }
}
