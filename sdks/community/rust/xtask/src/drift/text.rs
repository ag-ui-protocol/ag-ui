//! Small text utilities shared by the TypeScript and Rust scanners.
//!
//! Both scanners read source as plain text — the drift check must work when
//! `ag-ui` does not compile and when no TypeScript toolchain is present.
//! Everything here is therefore delimiter counting with string-literal
//! awareness, nothing more.

/// The closing delimiter for an opening one.
fn closing(open: char) -> Option<char> {
    match open {
        '{' => Some('}'),
        '(' => Some(')'),
        '[' => Some(']'),
        _ => None,
    }
}

/// Byte index of the delimiter matching the one at `open`, or `None` when the
/// source is unbalanced.
///
/// `open` must be a byte index of an opening delimiter in `s`. Nested
/// delimiters and string literals (`"`, `'`, backtick) are skipped.
pub fn match_delim(s: &str, open: usize) -> Option<usize> {
    let open_ch = s[open..].chars().next()?;
    let close_ch = closing(open_ch)?;
    let mut depth = 0usize;
    let mut it = s[open..].char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '"' | '\'' | '`' => skip_string(&mut it, c),
            _ if c == open_ch => depth += 1,
            _ if c == close_ch => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Consumes an iterator up to and including the closing `quote`.
fn skip_string(it: &mut std::str::CharIndices<'_>, quote: char) {
    let mut escaped = false;
    for (_, c) in it.by_ref() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return;
        }
    }
}

/// Splits `s` on `sep` occurrences that sit outside every delimiter pair and
/// string literal. Empty (whitespace-only) pieces are dropped, so a trailing
/// comma costs nothing.
pub fn split_top_level(s: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut it = s.char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '"' | '\'' | '`' => skip_string(&mut it, c),
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            _ if c == sep && depth == 0 => {
                push_trimmed(&mut out, &s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    push_trimmed(&mut out, &s[start..]);
    out
}

fn push_trimmed<'a>(out: &mut Vec<&'a str>, piece: &'a str) {
    let piece = piece.trim();
    if !piece.is_empty() {
        out.push(piece);
    }
}

/// Byte index of the first `needle` in `s` that sits outside every delimiter
/// pair and string literal.
pub fn find_top_level(s: &str, needle: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut it = s.char_indices();
    while let Some((i, c)) = it.next() {
        if depth == 0 && s[i..].starts_with(needle) {
            return Some(i);
        }
        match c {
            '"' | '\'' | '`' => skip_string(&mut it, c),
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// Replaces `//` and `/* */` comments with spaces, keeping every newline so
/// byte offsets stay usable for line numbers.
pub fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '/' if s[i..].starts_with("//") => {
                for (_, c) in it.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
                out.push('\n');
            }
            '/' if s[i..].starts_with("/*") => {
                let mut prev = ' ';
                for (_, c) in it.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                    }
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            '"' | '\'' | '`' => {
                out.push(c);
                let quote = c;
                let mut escaped = false;
                for (_, c) in it.by_ref() {
                    out.push(c);
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == quote {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Replaces the apostrophe that opens a Rust lifetime with a space.
///
/// Rust and TypeScript disagree about `'`. In TypeScript it always quotes a
/// string, which is what everything above assumes. In Rust it does too — a
/// char literal — but it *also* introduces a lifetime, and a scanner that
/// reads `&'static str` as an opening quote then skips everything up to the
/// next apostrophe in the file, closing braces included. That is not
/// hypothetical: it swallowed the end of a payload struct, the struct scanned
/// as declaring no fields at all, and `drift-check` reported four fields as
/// missing from a struct that has them. A scanner that invents drift is on its
/// way to being ignored, which is the outcome this crate exists to prevent.
///
/// So the Rust scanner blanks lifetimes before reading anything, and the
/// shared functions keep their one simple rule. Blanking is
/// length-preserving, so every byte offset stays valid, and char literals
/// (`'a'`, `'}'`) are left alone because those really are strings and must go
/// on being skipped. TypeScript never comes through here: it has no lifetimes,
/// and its single-quoted strings must keep working.
pub fn blank_lifetimes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('\'') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let name = read_ident(after, 0);
        // `'a'` closes; `'\n'` and `'}'` have no identifier at all. Only an
        // identifier with nothing closing it is a lifetime.
        let is_lifetime = !name.is_empty() && !after[name.len()..].starts_with('\'');
        out.push(if is_lifetime { ' ' } else { '\'' });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Reads the identifier starting at byte index `at`, or an empty string.
pub fn read_ident(s: &str, at: usize) -> &str {
    let rest = &s[at..];
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(rest.len());
    &rest[..end]
}

/// `TEXT_MESSAGE_START` -> `TextMessageStart`.
pub fn screaming_snake_to_pascal(s: &str) -> String {
    s.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut c = part.chars();
            match c.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect()
}

/// `TextMessageStart` -> `TEXT_MESSAGE_START`.
///
/// Runs of capitals stay together (`JSONPatch` -> `JSON_PATCH`, not
/// `J_S_O_N_PATCH`), which is the same rule serde's `SCREAMING_SNAKE_CASE`
/// applies to variant names.
pub fn pascal_to_screaming_snake(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if c.is_uppercase() && i > 0 {
            let prev = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            if !prev.is_uppercase() || next_is_lower {
                out.push('_');
            }
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

/// `message_id` -> `messageId`.
pub fn snake_to_camel(s: &str) -> String {
    let pascal = snake_to_pascal(s);
    let mut c = pascal.chars();
    match c.next() {
        Some(first) => first.to_lowercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

/// `message_id` -> `MessageId`.
pub fn snake_to_pascal(s: &str) -> String {
    s.split('_')
        .map(|part| {
            let mut c = part.chars();
            match c.next() {
                Some(first) => first.to_uppercase().to_string() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// Applies a serde `rename_all` rule to an already-snake_case name.
///
/// Unknown rules are returned unchanged rather than guessed at — a wrong guess
/// here would be reported as drift that does not exist.
pub fn apply_rename_all(name: &str, rule: &str) -> String {
    match rule {
        "lowercase" => name.replace('_', "").to_lowercase(),
        "UPPERCASE" => name.replace('_', "").to_uppercase(),
        "PascalCase" => snake_to_pascal(name),
        "camelCase" => snake_to_camel(name),
        "snake_case" => name.to_string(),
        "SCREAMING_SNAKE_CASE" => name.to_uppercase(),
        "kebab-case" => name.replace('_', "-"),
        "SCREAMING-KEBAB-CASE" => name.to_uppercase().replace('_', "-"),
        _ => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_nested_delimiters_and_skips_strings() {
        let s = "a({ b: \"})\" , c: (1) })x";
        let open = s.find('(').unwrap();
        let close = match_delim(s, open).unwrap();
        assert_eq!(&s[open..=close], "({ b: \"})\" , c: (1) })");
    }

    #[test]
    fn splits_only_at_depth_zero() {
        let parts = split_top_level("a: z.foo(1, 2), b: [3, 4], c: \"x,y\",", ',');
        assert_eq!(parts, vec!["a: z.foo(1, 2)", "b: [3, 4]", "c: \"x,y\""]);
    }

    #[test]
    fn find_top_level_ignores_nested_matches() {
        assert_eq!(
            find_top_level("z.array(z.any().optional())", ".optional("),
            None
        );
        assert_eq!(
            find_top_level("z.string().optional()", ".optional("),
            Some(10)
        );
    }

    /// The failure this guards: a lifetime opened a string that never closed,
    /// so a struct's own `}` was skipped and the rest of the file read as one
    /// item — with no fields.
    #[test]
    fn lifetimes_are_blanked_so_they_cannot_open_a_string() {
        let src = "fn f<'de, D>(d: D) -> &'static str { \"x\" }\nstruct S { a: u8 }\n";
        let blanked = blank_lifetimes(src);
        assert_eq!(blanked.len(), src.len(), "offsets must survive");
        assert!(blanked.contains("fn f< de, D>"), "{blanked}");
        assert!(blanked.contains("& static str"), "{blanked}");

        let open = blanked.rfind('{').unwrap();
        assert_eq!(
            match_delim(&blanked, open).map(|c| &blanked[open..=c]),
            Some("{ a: u8 }")
        );
    }

    /// Blanking must not swallow the comments after a lifetime either, or a
    /// doc comment's brackets and braces end up scanned as code.
    #[test]
    fn a_lifetime_does_not_swallow_the_comments_after_it() {
        let src = "fn f() -> &'static str { \"x\" }\n/// see [`crate::event`]\nstruct S;\n";
        let out = strip_comments(&blank_lifetimes(src));
        assert!(!out.contains("crate::event"), "{out}");
    }

    #[test]
    fn char_literals_and_single_quoted_strings_are_left_as_strings() {
        // Rust: a char literal closes, so it is not a lifetime and the brace
        // inside it must go on being skipped.
        let rust = "match c { '}' => 1, 'a' => 2, _ => 0 }";
        let blanked = blank_lifetimes(rust);
        assert_eq!(blanked, rust);
        let open = rust.find('{').unwrap();
        assert_eq!(match_delim(rust, open), Some(rust.len() - 1));
        // TypeScript, which never goes through the blanking: a single-quoted
        // value is one piece, comma and all.
        assert_eq!(
            split_top_level("a: 'x,y', b: 1", ','),
            vec!["a: 'x,y'", "b: 1"]
        );
    }

    #[test]
    fn strips_comments_but_keeps_lines() {
        let src = "a // one\nb /* two\nthree */ c\nd \"// not a comment\"\n";
        let out = strip_comments(src);
        assert_eq!(out.lines().count(), src.lines().count());
        assert!(!out.contains("one"));
        assert!(!out.contains("three"));
        assert!(out.contains("// not a comment"));
    }

    #[test]
    fn case_conversions_round_trip_event_names() {
        assert_eq!(
            screaming_snake_to_pascal("TEXT_MESSAGE_START"),
            "TextMessageStart"
        );
        assert_eq!(
            pascal_to_screaming_snake("TextMessageStart"),
            "TEXT_MESSAGE_START"
        );
        assert_eq!(pascal_to_screaming_snake("Raw"), "RAW");
        assert_eq!(
            pascal_to_screaming_snake("ReasoningEncryptedValue"),
            "REASONING_ENCRYPTED_VALUE"
        );
        assert_eq!(snake_to_camel("message_id"), "messageId");
        assert_eq!(apply_rename_all("message_id", "camelCase"), "messageId");
        assert_eq!(
            apply_rename_all("tool_call_id", "SCREAMING_SNAKE_CASE"),
            "TOOL_CALL_ID"
        );
    }
}
