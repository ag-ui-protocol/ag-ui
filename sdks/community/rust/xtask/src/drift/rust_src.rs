//! Extracts the event surface from `crates/ag-ui/src/event/**/*.rs`.
//!
//! Deliberately a text scanner, not a compiler: `drift-check` has to keep
//! working while `ag-ui` is mid-refactor and does not build. It reads
//! whichever of the two shapes the crate uses (or both at once):
//!
//! * a `#[serde(tag = "type")]` enum, where the wire tag is either an explicit
//!   `#[serde(rename = "TEXT_MESSAGE_START")]` or the variant name;
//! * a macro table that generates that enum, whose entries pair a payload type
//!   with its tag (`TextMessageStart(TextMessageStartEvent) => "TEXT_MESSAGE_START"`);
//! * per-event payload structs named `<Name>Event`, where the wire tag follows
//!   from the type name.
//!
//! It also reads the `BaseEvent` envelope on its own. That struct is not an
//! event type — it is flattened into every payload — so it belongs to none of
//! the shapes above, and its fields are fields of all 36 events.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::drift::text::{
    apply_rename_all, blank_lifetimes, match_delim, pascal_to_screaming_snake, read_ident,
    split_top_level, strip_comments,
};

/// The envelope struct every payload flattens in. Not an event type itself,
/// but its fields are fields of every event, so it is read separately.
pub const BASE_EVENT: &str = "BaseEvent";

/// Structs that end in `Event` but are envelope plumbing, not event types.
const NOT_EVENTS: &[&str] = &[BASE_EVENT, "AnyEvent"];

/// One field of an event payload, named as it appears on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustField {
    pub name: String,
    pub required: bool,
}

/// One event type as the Rust source declares it.
#[derive(Debug, Clone)]
pub struct RustEvent {
    /// Wire tag, e.g. `TEXT_MESSAGE_START`.
    pub tag: String,
    /// The Rust type carrying the payload, when there is one.
    pub rust_type: Option<String>,
    /// Repo-relative file the type was found in.
    pub file: String,
    /// Payload fields, excluding anything `#[serde(flatten)]`ed in. `None` when
    /// only the enum variant was found and no payload type could be located.
    pub fields: Option<Vec<RustField>>,
    pub from_enum: bool,
    pub from_struct: bool,
}

/// The envelope every event payload flattens in, as the Rust source declares
/// it.
#[derive(Debug, Clone)]
pub struct RustBaseEvent {
    /// Its fields, named as they appear on the wire.
    pub fields: Vec<RustField>,
    /// Repo-relative file it was found in.
    pub file: String,
}

/// Everything the scan found.
#[derive(Debug, Clone, Default)]
pub struct RustSurface {
    /// One entry per wire tag, sorted.
    pub events: Vec<RustEvent>,
    /// The `BaseEvent` envelope, when the module declares one. `None` is not
    /// drift — the comparison warns instead, the same way an unreadable
    /// payload does.
    pub base_event: Option<RustBaseEvent>,
    /// Name of the `#[serde(tag = "type")]` enum, when the crate has one yet.
    pub tagged_enum: Option<String>,
    /// Repo-relative paths scanned, sorted.
    pub files: Vec<String>,
    /// Things worth mentioning that are not drift (e.g. an unresolved payload).
    pub notes: Vec<String>,
}

/// Scans `dir` recursively for the event surface.
pub fn scan(dir: &Path, repo_root: &Path) -> Result<RustSurface, String> {
    let mut files = Vec::new();
    collect_rs_files(dir, &mut files)?;
    files.sort();

    let mut structs: BTreeMap<String, (Vec<RustField>, String)> = BTreeMap::new();
    let mut struct_order: Vec<(String, String)> = Vec::new();
    let mut variants: Vec<UnionMember> = Vec::new();
    let mut tagged_enum = None;
    let mut notes = Vec::new();
    let mut any_flattened_base = false;
    let mut flattening_structs: Vec<String> = Vec::new();

    for path in &files {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let rel = relative(path, repo_root);
        // Lifetimes first: an apostrophe that is not a quote has to stop
        // looking like one before anything counts delimiters. See
        // [`blank_lifetimes`].
        for item in scan_items(&strip_comments(&blank_lifetimes(&text))) {
            match item.kind {
                ItemKind::Struct => {
                    let parsed = parse_fields(&item.body, container_rename_all(&item.attrs));
                    if parsed.flattened {
                        any_flattened_base = true;
                        flattening_structs.push(item.name.clone());
                    }
                    struct_order.push((item.name.clone(), rel.clone()));
                    structs.insert(item.name, (parsed.fields, rel.clone()));
                }
                ItemKind::Enum => {
                    if !serde_args(&item.attrs)
                        .iter()
                        .any(|arg| arg_value(arg, "tag").as_deref() == Some("type"))
                    {
                        continue;
                    }
                    let rename_all = container_rename_all(&item.attrs);
                    let rename_fields = serde_args(&item.attrs)
                        .iter()
                        .find_map(|arg| arg_value(arg, "rename_all_fields"));
                    let members = parse_variants(
                        &item.body,
                        rename_all.as_deref(),
                        rename_fields.as_deref(),
                        &rel,
                    );
                    // `type` is a common discriminator, and the event union is
                    // not the only thing that uses it — `SubagentOutcome` is
                    // tagged `type` with variants `success` and `suspended`.
                    // Every AG-UI event tag is SCREAMING_SNAKE, so an enum
                    // whose variants are not is somebody else's union, and
                    // reading it would invent two event types that do not
                    // exist. An enum with no readable variants at all is the
                    // macro-generated union, whose members come from the
                    // macro's table instead, so it still counts.
                    if !members.is_empty() && !members.iter().any(|m| is_wire_tag(&m.tag)) {
                        continue;
                    }
                    if let Some(previous) = tagged_enum.replace(item.name.clone()) {
                        notes.push(format!(
                            "two `#[serde(tag = \"type\")]` enums found ({previous} and {}); \
                             both were read",
                            item.name
                        ));
                    }
                    variants.extend(members.into_iter().filter(|m| is_wire_tag(&m.tag)));
                }
                ItemKind::Macro => variants.extend(parse_macro_table(&item.body, &rel)),
                ItemKind::Other => {}
            }
        }
    }

    let mut events: BTreeMap<String, RustEvent> = BTreeMap::new();

    for UnionMember {
        tag,
        payload,
        inline_fields,
        mut file,
    } in variants
    {
        // Point at the payload struct when there is one: that is the file a
        // person has to open to fix a field mismatch.
        let (rust_type, fields) = match (&payload, inline_fields) {
            (_, Some(fields)) => (payload.clone(), Some(fields)),
            (Some(name), None) => {
                let found = structs.get(name);
                if let Some((_, struct_file)) = found {
                    file.clone_from(struct_file);
                }
                (Some(name.clone()), found.map(|(fields, _)| fields.clone()))
            }
            (None, None) => (None, Some(Vec::new())),
        };
        if fields.is_none() {
            if let Some(name) = &rust_type {
                notes.push(format!(
                    "variant for {tag} carries `{name}`, which was not found under the event \
                     module; its fields were not compared"
                ));
            }
        }
        events.insert(
            tag.clone(),
            RustEvent {
                tag,
                rust_type,
                file,
                fields,
                from_enum: true,
                from_struct: false,
            },
        );
    }

    for (name, file) in struct_order {
        if !name.ends_with("Event") || NOT_EVENTS.contains(&name.as_str()) {
            continue;
        }
        // When the crate carries the envelope by flattening a `BaseEvent` into
        // each payload, that flatten is the marker of an event type; helper
        // structs whose names happen to end in `Event` are skipped. If nothing
        // in the tree flattens, fall back to accepting every `*Event` struct.
        if any_flattened_base && !flattening_structs.contains(&name) {
            continue;
        }
        let tag = pascal_to_screaming_snake(name.trim_end_matches("Event"));
        let fields = structs.get(&name).map(|(fields, _)| fields.clone());
        match events.get_mut(&tag) {
            Some(existing) => {
                existing.from_struct = true;
                if existing.fields.is_none() {
                    existing.fields.clone_from(&fields);
                    existing.rust_type = Some(name.clone());
                    existing.file.clone_from(&file);
                }
            }
            None => {
                events.insert(
                    tag.clone(),
                    RustEvent {
                        tag,
                        rust_type: Some(name),
                        file,
                        fields,
                        from_enum: false,
                        from_struct: true,
                    },
                );
            }
        }
    }

    // The envelope is deliberately not an event, so nothing above would have
    // picked it up — and a field added there is a field on every event.
    let base_event = structs.get(BASE_EVENT).map(|(fields, file)| RustBaseEvent {
        fields: fields.clone(),
        file: file.clone(),
    });

    Ok(RustSurface {
        events: events.into_values().collect(),
        base_event,
        tagged_enum,
        files: files.iter().map(|p| relative(p, repo_root)).collect(),
        notes,
    })
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|e| format!("{}: {e}", dir.display()))?.path();
        if path.is_dir() {
            collect_rs_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

fn relative(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ItemKind {
    Struct,
    Enum,
    /// A macro definition or invocation. Its body is walked for items and read
    /// for a tag table.
    Macro,
    Other,
}

#[derive(Debug)]
struct Item {
    kind: ItemKind,
    name: String,
    attrs: Vec<String>,
    body: String,
}

/// Walks top-level items, carrying each one's attributes with it.
///
/// `#[cfg(test)]` modules are skipped whole; other inline modules are walked.
fn scan_items(src: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let mut attrs: Vec<String> = Vec::new();
    let mut pos = 0usize;

    while pos < src.len() {
        let line_end = src[pos..].find('\n').map(|i| pos + i).unwrap_or(src.len());
        let line = src[pos..line_end].trim();

        if line.is_empty() {
            pos = line_end + 1;
            continue;
        }

        if line.starts_with("#[") || line.starts_with("#![") {
            let open = pos + src[pos..line_end].find('[').unwrap_or(0);
            match match_delim(src, open) {
                Some(close) => {
                    attrs.push(src[open + 1..close].trim().to_string());
                    pos = close + 1;
                }
                None => pos = line_end + 1,
            }
            continue;
        }

        match item_head(line) {
            Some((kind, name)) => {
                let name_at = pos + src[pos..line_end].find(&name).unwrap_or(0) + name.len();
                let (body, next) = item_body(src, name_at);
                let is_test_mod = kind == ItemKind::Other
                    && line.contains("mod ")
                    && attrs.iter().any(|a| a.replace(' ', "") == "cfg(test)");
                match kind {
                    ItemKind::Other if line.contains("mod ") && !is_test_mod => {
                        items.extend(scan_items(&body));
                    }
                    ItemKind::Other => {}
                    // A macro body can both declare items (the generated enum)
                    // and hold the tag table, so it is read as each in turn.
                    ItemKind::Macro => {
                        items.extend(scan_items(&body));
                        items.push(Item {
                            kind,
                            name,
                            attrs: std::mem::take(&mut attrs),
                            body,
                        });
                    }
                    ItemKind::Struct | ItemKind::Enum => items.push(Item {
                        kind,
                        name,
                        attrs: std::mem::take(&mut attrs),
                        body,
                    }),
                }
                attrs.clear();
                pos = next;
            }
            None => {
                attrs.clear();
                pos = line_end + 1;
            }
        }
    }
    items
}

/// Recognises `pub struct Foo`, `enum Bar`, `pub(crate) mod baz` and
/// `some_macro! {` heads.
fn item_head(line: &str) -> Option<(ItemKind, String)> {
    let mut rest = line;
    if let Some(after) = rest.strip_prefix("pub") {
        rest = after.trim_start();
        if rest.starts_with('(') {
            let close = rest.find(')')?;
            rest = rest[close + 1..].trim_start();
        }
    }
    for prefix in ["default ", "async "] {
        if let Some(after) = rest.strip_prefix(prefix) {
            rest = after.trim_start();
        }
    }
    let (kind, keyword) = if rest.starts_with("struct ") {
        (ItemKind::Struct, "struct ")
    } else if rest.starts_with("enum ") {
        (ItemKind::Enum, "enum ")
    } else if rest.starts_with("mod ") {
        (ItemKind::Other, "mod ")
    } else {
        let name = read_ident(rest, 0);
        let after = rest[name.len()..].trim_start();
        let is_macro = !name.is_empty()
            && after.starts_with('!')
            && after[1..].trim_start().starts_with(['{', '(', '[']);
        return is_macro.then(|| (ItemKind::Macro, name.to_string()));
    };
    let name = read_ident(rest[keyword.len()..].trim_start(), 0).to_string();
    if name.is_empty() {
        return None;
    }
    Some((kind, name))
}

/// Body of the item whose name ends at `at`, plus the offset just past it.
fn item_body(src: &str, at: usize) -> (String, usize) {
    let open = src[at..]
        .find(['{', '(', '[', ';'])
        .map(|i| at + i)
        .unwrap_or(src.len());
    if open >= src.len() || src[open..].starts_with(';') {
        return (String::new(), (open + 1).min(src.len()));
    }
    match match_delim(src, open) {
        Some(close) => (src[open + 1..close].to_string(), close + 1),
        None => (String::new(), src.len()),
    }
}

#[derive(Debug, Default)]
struct ParsedFields {
    fields: Vec<RustField>,
    /// Whether the struct flattens another type in — the envelope marker.
    flattened: bool,
}

/// Reads named fields out of a struct or struct-variant body.
fn parse_fields(body: &str, rename_all: Option<String>) -> ParsedFields {
    let mut out = ParsedFields::default();
    let mut attrs: Vec<String> = Vec::new();
    let mut pos = 0usize;

    while pos < body.len() {
        let line_end = body[pos..]
            .find('\n')
            .map(|i| pos + i)
            .unwrap_or(body.len());
        let line = body[pos..line_end].trim();

        if line.is_empty() {
            pos = line_end + 1;
            continue;
        }
        if line.starts_with("#[") {
            let open = pos + body[pos..line_end].find('[').unwrap_or(0);
            match match_delim(body, open) {
                Some(close) => {
                    attrs.push(body[open + 1..close].trim().to_string());
                    pos = close + 1;
                }
                None => pos = line_end + 1,
            }
            continue;
        }

        let Some((name, type_start)) = field_head(body, pos, line_end) else {
            attrs.clear();
            pos = line_end + 1;
            continue;
        };
        let type_end = type_start + find_type_end(&body[type_start..]);
        let ty = body[type_start..type_end].trim();
        let args = serde_args(&attrs);
        pos = type_end + 1;

        if args.iter().any(|a| has_flag(a, "flatten")) {
            out.flattened = true;
            attrs.clear();
            continue;
        }
        if args.iter().any(|a| has_flag(a, "skip")) {
            attrs.clear();
            continue;
        }
        let wire = args
            .iter()
            .find_map(|a| arg_value(a, "rename"))
            .unwrap_or_else(|| match &rename_all {
                Some(rule) => apply_rename_all(&name, rule),
                None => name.clone(),
            });
        let has_default = args
            .iter()
            .any(|a| has_flag(a, "default") || arg_value(a, "default").is_some());
        out.fields.push(RustField {
            name: wire,
            required: !(ty.starts_with("Option<") || has_default),
        });
        attrs.clear();
    }
    out
}

/// `pub message_id: MessageId,` -> (`message_id`, offset of `MessageId`).
fn field_head(body: &str, pos: usize, line_end: usize) -> Option<(String, usize)> {
    let line = &body[pos..line_end];
    let trimmed = line.trim_start();
    let mut offset = pos + (line.len() - trimmed.len());
    let mut rest = trimmed;
    if let Some(after) = rest.strip_prefix("pub") {
        let vis_len = rest.len() - after.len();
        rest = after.trim_start();
        offset += vis_len + (after.len() - rest.len());
        if rest.starts_with('(') {
            let close = rest.find(')')? + 1;
            offset += close;
            let after = rest[close..].trim_start();
            offset += rest[close..].len() - after.len();
            rest = after;
        }
    }
    let name = read_ident(rest, 0);
    if name.is_empty() {
        return None;
    }
    let after_name = rest[name.len()..].trim_start();
    if !after_name.starts_with(':') || after_name.starts_with("::") {
        return None;
    }
    let colon_at = offset + (rest.len() - after_name.len()) + 1;
    Some((name.to_string(), colon_at))
}

/// Length of the type expression at the start of `s`, up to the `,` that ends
/// the field. Generics, tuples and slices nest.
fn find_type_end(s: &str) -> usize {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => {
                if depth == 0 {
                    return i;
                }
                depth -= 1;
            }
            ',' if depth == 0 => return i,
            _ => {}
        }
    }
    s.len()
}

/// One member of the tagged union, wherever it was declared.
#[derive(Debug)]
struct UnionMember {
    /// Wire tag.
    tag: String,
    /// The payload type the variant wraps, if it wraps one.
    payload: Option<String>,
    /// Fields declared inline on a struct variant. `None` means "look the
    /// payload type up"; `Some(vec![])` means "this variant has no fields".
    inline_fields: Option<Vec<RustField>>,
    /// Repo-relative file the declaration was read from.
    file: String,
}

/// Reads the variants of a `#[serde(tag = "type")]` enum.
fn parse_variants(
    body: &str,
    rename_all: Option<&str>,
    rename_all_fields: Option<&str>,
    file: &str,
) -> Vec<UnionMember> {
    let mut out = Vec::new();
    let mut attrs: Vec<String> = Vec::new();
    let mut pos = 0usize;

    while pos < body.len() {
        let line_end = body[pos..]
            .find('\n')
            .map(|i| pos + i)
            .unwrap_or(body.len());
        let line = body[pos..line_end].trim();

        if line.is_empty() {
            pos = line_end + 1;
            continue;
        }
        if line.starts_with("#[") {
            let open = pos + body[pos..line_end].find('[').unwrap_or(0);
            match match_delim(body, open) {
                Some(close) => {
                    attrs.push(body[open + 1..close].trim().to_string());
                    pos = close + 1;
                }
                None => pos = line_end + 1,
            }
            continue;
        }

        let name = read_ident(line, 0).to_string();
        if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_uppercase()) {
            attrs.clear();
            pos = line_end + 1;
            continue;
        }

        let args = serde_args(&attrs);
        if args.iter().any(|a| has_flag(a, "skip")) {
            attrs.clear();
            pos = line_end + 1;
            continue;
        }
        // An explicit rename wins; otherwise apply the container rule to the
        // variant name. Serde's own default is the bare variant name, but the
        // AG-UI wire form is always SCREAMING_SNAKE, so that is what an
        // unannotated variant is read as rather than reported as drift.
        let tag = args
            .iter()
            .find_map(|a| arg_value(a, "rename"))
            .unwrap_or_else(|| match rename_all {
                // serde applies `rename_all` to the snake_case form of the name.
                Some(rule) => {
                    apply_rename_all(&pascal_to_screaming_snake(&name).to_lowercase(), rule)
                }
                None => pascal_to_screaming_snake(&name),
            });

        let after = line[name.len()..].trim_start();
        let (payload, inline, next) = if after.starts_with('(') {
            let open = pos + body[pos..line_end].find('(').unwrap_or(0);
            match match_delim(body, open) {
                Some(close) => {
                    let inner = body[open + 1..close].trim();
                    let ty = inner.rsplit("::").next().unwrap_or(inner).trim();
                    let ty = ty.split('<').next().unwrap_or(ty).trim();
                    let ty = (!ty.is_empty() && !ty.contains(',')).then(|| ty.to_string());
                    (ty, None, close + 1)
                }
                None => (None, None, line_end + 1),
            }
        } else if after.starts_with('{') {
            let open = pos + body[pos..line_end].find('{').unwrap_or(0);
            match match_delim(body, open) {
                Some(close) => {
                    let parsed = parse_fields(
                        &body[open + 1..close],
                        rename_all_fields.map(str::to_string),
                    );
                    (None, Some(parsed.fields), close + 1)
                }
                None => (None, None, line_end + 1),
            }
        } else {
            (None, Some(Vec::new()), line_end + 1)
        };

        out.push(UnionMember {
            tag,
            payload,
            inline_fields: inline,
            file: file.to_string(),
        });
        attrs.clear();
        pos = next;
    }
    out
}

/// Reads a macro table that pairs payload types with wire tags, as in
/// `TextMessageStart(TextMessageStartEvent) => "TEXT_MESSAGE_START",`.
///
/// Generating the event enum from such a table is a common way to keep the
/// union, the discriminator enum and the constructors in one place — and it
/// hides every tag from a scanner that only reads `enum` bodies. Entries are
/// only accepted when a tag literal and a payload type appear together, so
/// unrelated macros carrying SCREAMING_SNAKE strings are not mistaken for
/// event declarations.
fn parse_macro_table(body: &str, file: &str) -> Vec<UnionMember> {
    let mut out = Vec::new();
    for entry in split_top_level(body, ',') {
        let entry = strip_attributes(entry);
        let Some(tag) = screaming_snake_literal(&entry) else {
            continue;
        };
        let Some((variant, payload)) = variant_call(&entry) else {
            continue;
        };
        if !payload.ends_with("Event") && pascal_to_screaming_snake(&variant) != tag {
            continue;
        }
        out.push(UnionMember {
            tag,
            payload: Some(payload),
            inline_fields: None,
            file: file.to_string(),
        });
    }
    out
}

/// Removes `#[...]` attributes from a macro-table entry.
fn strip_attributes(entry: &str) -> String {
    let mut out = entry.to_string();
    while let Some(hash) = out.find("#[") {
        match match_delim(&out, hash + 1) {
            Some(close) => out.replace_range(hash..=close, ""),
            None => break,
        }
    }
    out
}

/// The first `"SCREAMING_SNAKE"` string literal in `entry`.
fn screaming_snake_literal(entry: &str) -> Option<String> {
    let mut rest = entry;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let close = after.find('"')?;
        let literal = &after[..close];
        if is_wire_tag(literal) {
            return Some(literal.to_string());
        }
        rest = &after[close + 1..];
    }
    None
}

/// Whether a string has the shape of an AG-UI event tag.
///
/// Every one of them is SCREAMING_SNAKE, which is what separates an event tag
/// from any other string a declaration happens to carry.
fn is_wire_tag(tag: &str) -> bool {
    tag.starts_with(|c: char| c.is_ascii_uppercase())
        && tag
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// The first `Variant(PayloadType)` in `entry`, as `(variant, payload)`.
fn variant_call(entry: &str) -> Option<(String, String)> {
    let mut at = 0usize;
    while at < entry.len() {
        let name = read_ident(entry, at);
        if !name.is_empty() {
            let after = at + name.len();
            if name.starts_with(|c: char| c.is_ascii_uppercase()) && entry[after..].starts_with('(')
            {
                if let Some(close) = match_delim(entry, after) {
                    let inner = entry[after + 1..close].trim();
                    let payload = inner
                        .rsplit("::")
                        .next()
                        .unwrap_or(inner)
                        .split('<')
                        .next()
                        .unwrap_or(inner)
                        .trim();
                    if !payload.is_empty() && !payload.contains(',') {
                        return Some((name.to_string(), payload.to_string()));
                    }
                }
            }
            at = after;
        }
        at += entry[at..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

/// The argument lists of every `serde(...)` attribute in `attrs`.
fn serde_args(attrs: &[String]) -> Vec<String> {
    attrs
        .iter()
        .filter_map(|attr| {
            let rest = attr.trim().strip_prefix("serde")?.trim_start();
            let close = match_delim(rest, rest.find('(')?)?;
            Some(rest[rest.find('(')? + 1..close].to_string())
        })
        .collect()
}

/// `rename = "X"` inside a serde argument list.
fn arg_value(args: &str, key: &str) -> Option<String> {
    split_top_level(args, ',').into_iter().find_map(|arg| {
        let (name, value) = arg.split_once('=')?;
        (name.trim() == key).then(|| value.trim().trim_matches('"').to_string())
    })
}

/// A bare `flatten` / `skip` / `default` flag inside a serde argument list.
fn has_flag(args: &str, key: &str) -> bool {
    split_top_level(args, ',')
        .iter()
        .any(|arg| arg.trim() == key)
}

fn container_rename_all(attrs: &[String]) -> Option<String> {
    serde_args(attrs)
        .iter()
        .find_map(|arg| arg_value(arg, "rename_all"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(surface: &RustSurface, tag: &str) -> Vec<RustField> {
        surface
            .events
            .iter()
            .find(|e| e.tag == tag)
            .unwrap()
            .fields
            .clone()
            .unwrap()
    }

    /// Scans one source file, through the real directory walk. Tests run in
    /// parallel, so each gets its own directory.
    fn scan_str(src: &str) -> RustSurface {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);

        let dir = std::env::temp_dir().join(format!(
            "xtask-drift-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("event.rs"), src).unwrap();
        let surface = scan(&dir, &dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        surface
    }

    #[test]
    fn a_module_with_no_event_types_scans_to_nothing() {
        // `run()` turns this into a hard error rather than a silent pass: a
        // scanner that reads zero events must never look like agreement.
        let surface = scan_str(
            r#"
pub struct Helper {
    pub a: u8,
}

pub enum Untagged {
    One,
}
"#,
        );
        assert!(surface.events.is_empty());
        assert_eq!(surface.tagged_enum, None);
        assert_eq!(surface.files.len(), 1);
    }

    #[test]
    fn reads_payload_structs() {
        let surface = scan_str(
            r#"
/// Doc comment mentioning struct NotAnItem.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message_id: MessageId,
    #[serde(default)]
    pub role: TextMessageRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip)]
    pub internal: u8,
}

#[derive(Serialize)]
pub struct BaseEvent {
    pub timestamp: Option<i64>,
}

#[cfg(test)]
mod tests {
    #[derive(Serialize)]
    pub struct GhostEvent {
        #[serde(flatten)]
        pub base: BaseEvent,
    }
}
"#,
        );
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["TEXT_MESSAGE_START"]
        );
        assert_eq!(
            fields(&surface, "TEXT_MESSAGE_START"),
            [
                RustField {
                    name: "messageId".into(),
                    required: true
                },
                RustField {
                    name: "role".into(),
                    required: false
                },
                RustField {
                    name: "name".into(),
                    required: false
                },
            ]
        );
    }

    #[test]
    fn reads_tagged_enum_with_explicit_renames() {
        let surface = scan_str(
            r#"
#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "TEXT_MESSAGE_START")]
    TextMessageStart(TextMessageStartEvent),
    #[serde(rename = "RUN_ERROR")]
    RunError(RunErrorEvent),
}

#[serde(rename_all = "camelCase")]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message_id: String,
}
"#,
        );
        assert_eq!(surface.tagged_enum.as_deref(), Some("Event"));
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["RUN_ERROR", "TEXT_MESSAGE_START"]
        );
        assert_eq!(
            fields(&surface, "TEXT_MESSAGE_START"),
            [RustField {
                name: "messageId".into(),
                required: true
            }]
        );
        // The payload type for RUN_ERROR is missing; that is a note, not a field
        // comparison against an empty struct.
        let run_error = surface
            .events
            .iter()
            .find(|e| e.tag == "RUN_ERROR")
            .unwrap();
        assert!(run_error.fields.is_none());
        assert_eq!(surface.notes.len(), 1);
    }

    #[test]
    fn reads_bare_variant_names_and_inline_fields() {
        let surface = scan_str(
            r#"
#[serde(
    tag = "type",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    StepStarted { step_name: String },
    Raw { event: Value, source: Option<String> },
}
"#,
        );
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["RAW", "STEP_STARTED"]
        );
        assert_eq!(
            fields(&surface, "STEP_STARTED"),
            [RustField {
                name: "stepName".into(),
                required: true
            }]
        );
        assert_eq!(
            fields(&surface, "RAW"),
            [
                RustField {
                    name: "event".into(),
                    required: true
                },
                RustField {
                    name: "source".into(),
                    required: false
                },
            ]
        );
    }

    #[test]
    fn reads_a_macro_generated_union() {
        let surface = scan_str(
            r#"
macro_rules! define_events {
    ($(
        $(#[$meta:meta])*
        $variant:ident($payload:ty) => $tag:literal,
    )*) => {
        #[derive(Serialize, Deserialize)]
        #[serde(tag = "type")]
        pub enum Event {
            $(
                $(#[$meta])*
                #[serde(rename = $tag)]
                $variant($payload),
            )*
        }
    };
}

define_events! {
    /// Opens a text message.
    TextMessageStart(TextMessageStartEvent) => "TEXT_MESSAGE_START",
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningEnd"))]
    ThinkingEnd(ThinkingEndEvent) => "THINKING_END",
}

#[serde(rename_all = "camelCase")]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message_id: String,
}

#[serde(rename_all = "camelCase")]
pub struct ThinkingEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Declared but never added to the union.
#[serde(rename_all = "camelCase")]
pub struct ActivityDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub patch: Vec<PatchOperation>,
}
"#,
        );
        assert_eq!(surface.tagged_enum.as_deref(), Some("Event"));
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["ACTIVITY_DELTA", "TEXT_MESSAGE_START", "THINKING_END"]
        );
        assert_eq!(
            fields(&surface, "TEXT_MESSAGE_START"),
            [RustField {
                name: "messageId".into(),
                required: true
            }]
        );
        // The macro's own definition must not be mistaken for a declaration,
        // and a struct outside the table is flagged by being enum-less.
        let union: Vec<&str> = surface
            .events
            .iter()
            .filter(|e| e.from_enum)
            .map(|e| e.tag.as_str())
            .collect();
        assert_eq!(union, ["TEXT_MESSAGE_START", "THINKING_END"]);
        assert!(surface.notes.is_empty());
    }

    /// The envelope is not an event, but its fields are on every event, so it
    /// is read on its own rather than skipped with the other non-events.
    #[test]
    fn reads_the_base_event_envelope() {
        let surface = scan_str(
            r#"
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<Value>,
    #[serde(default, deserialize_with = "reject_null", skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub event: Value,
}
"#,
        );
        let base = surface.base_event.expect("BaseEvent should have been read");
        assert_eq!(
            base.fields,
            [
                RustField {
                    name: "timestamp".into(),
                    required: false
                },
                RustField {
                    name: "rawEvent".into(),
                    required: false
                },
                RustField {
                    name: "metadata".into(),
                    required: false
                },
            ]
        );
        assert_eq!(base.file, "event.rs");
        // ...and it is still not an event type.
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["RAW"]
        );
    }

    #[test]
    fn a_module_without_a_base_event_reports_none_rather_than_empty() {
        let surface = scan_str(
            r#"
#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    pub event: Value,
}
"#,
        );
        assert!(surface.base_event.is_none());
    }

    /// `type` is a common discriminator. Reading every enum tagged with it as
    /// the event union turned `SubagentOutcome`'s `success` and `suspended`
    /// into two event types that upstream had never heard of.
    #[test]
    fn another_type_tagged_enum_is_not_the_event_union() {
        let surface = scan_str(
            r#"
define_events! {
    Raw(RawEvent) => "RAW",
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "RAW")]
    Raw(RawEvent),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SubagentOutcome {
    Success,
    Suspended { interrupt_ids: Option<Vec<String>> },
}

#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub event: Value,
}
"#,
        );
        assert_eq!(
            surface
                .events
                .iter()
                .map(|e| e.tag.clone())
                .collect::<Vec<_>>(),
            ["RAW"]
        );
        assert_eq!(surface.tagged_enum.as_deref(), Some("Event"));
        assert!(surface.notes.is_empty(), "{:?}", surface.notes);
    }

    /// End to end for the lifetime that swallowed a struct: the payload after
    /// `&'static str` must still be read, fields and all.
    #[test]
    fn a_lifetime_before_a_payload_does_not_hide_it() {
        let surface = scan_str(
            r#"
impl TextMessageRole {
    pub const fn as_str(&self) -> &'static str {
        "assistant"
    }
}

fn null_role_is_the_default<'de, D>(deserializer: D) -> Result<TextMessageRole, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(TextMessageRole::Assistant)
}

/// A doc comment with [`brackets`] and a `{` in it.
#[serde(rename_all = "camelCase")]
pub struct TextMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
}
"#,
        );
        assert_eq!(
            fields(&surface, "TEXT_MESSAGE_CHUNK"),
            [RustField {
                name: "messageId".into(),
                required: false
            }]
        );
    }

    #[test]
    fn generic_field_types_do_not_split_early() {
        let surface = scan_str(
            r#"
#[serde(rename_all = "camelCase")]
pub struct CustomEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub value: BTreeMap<String, Value>,
    pub name: String,
}
"#,
        );
        assert_eq!(
            fields(&surface, "CUSTOM"),
            [
                RustField {
                    name: "value".into(),
                    required: true
                },
                RustField {
                    name: "name".into(),
                    required: true
                },
            ]
        );
    }
}
