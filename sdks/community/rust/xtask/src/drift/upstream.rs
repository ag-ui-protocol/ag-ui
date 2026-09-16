//! Extracts the AG-UI event surface from the upstream TypeScript source of
//! truth (`sdks/typescript/packages/core/src/events.ts`).
//!
//! The upstream file is Zod, not a schema format, so this is deliberately a
//! narrow reader rather than a TypeScript parser. It understands exactly the
//! shapes the event declarations use:
//!
//! ```text
//! export enum EventType { NAME = "VALUE", ... }
//! export const XEventSchema = BaseEventSchema.extend({ field: z.string().optional(), ... });
//! export const YEventSchema = XEventSchema.omit({ a: true }).extend({ ... });
//! ```
//!
//! Anything else is recorded as `unparsed` and reported as a warning, never as
//! a failure — a drift check that cries wolf is a drift check that gets
//! disabled, which is the outcome this crate exists to prevent.

use std::collections::BTreeMap;

use crate::drift::optionality;
use crate::drift::text::{
    find_top_level, match_delim, read_ident, screaming_snake_to_pascal, split_top_level,
    strip_comments,
};

/// One field of an event payload, as declared upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub required: bool,
}

/// One event type and the payload the upstream schema declares for it.
#[derive(Debug, Clone)]
pub struct UpstreamEvent {
    pub event_type: String,
    /// Name of the Zod const the fields came from, when one was found.
    pub schema: Option<String>,
    /// Payload fields, excluding the `type` discriminator and the inherited
    /// `BaseEventSchema` fields. Empty and meaningless when `unparsed` is set.
    pub fields: Vec<Field>,
    /// Why the fields could not be trusted, when they could not be.
    pub unparsed: Option<String>,
}

/// The whole upstream event surface.
#[derive(Debug, Clone)]
pub struct Upstream {
    /// `EventType` values in declaration order.
    pub event_types: Vec<String>,
    /// Fields every event inherits from `BaseEventSchema` (minus `type`).
    pub base_fields: Vec<Field>,
    /// One entry per `EventType` value, in the same order.
    pub events: Vec<UpstreamEvent>,
    /// Readings that came from somewhere other than a Zod chain, one line each
    /// and never repeated. A reviewer accepting a refresh should see how an
    /// answer was arrived at when the file itself did not spell it out.
    pub notes: Vec<String>,
}

/// Reads `events.ts` and returns the event surface it declares.
pub fn extract(source: &str) -> Result<Upstream, String> {
    let src = strip_comments(source);
    let (enum_idents, event_types) = parse_event_type_enum(&src)?;
    let decls = collect_const_decls(&src);

    let mut parsed: BTreeMap<&str, ParsedSchema> = BTreeMap::new();
    for name in decls.keys() {
        let schema = resolve(name, &decls, &mut Vec::new());
        parsed.insert(name, schema);
    }

    // `type` is the discriminator, not a payload field, on either side.
    let discriminator = ["type".to_string()];
    let mut notes = Vec::new();
    let base_fields = parsed
        .get("BaseEventSchema")
        .map(|s| to_fields(&s.fields, &discriminator, &decls, &mut notes))
        .unwrap_or_default();
    let inherited: Vec<String> = discriminator
        .iter()
        .cloned()
        .chain(base_fields.iter().map(|f| f.name.clone()))
        .collect();

    // A schema belongs to an event type when its `type` field is a literal of
    // that `EventType` member. That is the same thing the discriminated union
    // keys on, so it cannot disagree with runtime behaviour.
    let mut by_event: BTreeMap<String, (&str, &ParsedSchema)> = BTreeMap::new();
    for (name, schema) in &parsed {
        let Some(literal) = schema.fields.iter().find(|(k, _)| k == "type") else {
            continue;
        };
        let Some(member) = event_type_literal(&literal.1) else {
            continue;
        };
        let value = enum_idents.get(&member).cloned().unwrap_or(member);
        if !event_types.contains(&value) {
            continue;
        }
        by_event.entry(value).or_insert((name, schema));
    }

    let events = event_types
        .iter()
        .map(|event_type| {
            build_event(
                event_type, &by_event, &parsed, &inherited, &decls, &mut notes,
            )
        })
        .collect();

    Ok(Upstream {
        event_types,
        base_fields,
        events,
        notes,
    })
}

fn build_event(
    event_type: &str,
    by_event: &BTreeMap<String, (&str, &ParsedSchema)>,
    parsed: &BTreeMap<&str, ParsedSchema>,
    inherited: &[String],
    decls: &BTreeMap<String, String>,
    notes: &mut Vec<String>,
) -> UpstreamEvent {
    if let Some((name, schema)) = by_event.get(event_type) {
        return UpstreamEvent {
            event_type: event_type.to_string(),
            schema: Some((*name).to_string()),
            fields: to_fields(&schema.fields, inherited, decls, notes),
            unparsed: schema.error.clone(),
        };
    }

    // Fall back to the naming convention so an unparseable schema still gets
    // named in the warning rather than vanishing.
    let guess = format!("{}EventSchema", screaming_snake_to_pascal(event_type));
    match parsed.get(guess.as_str()) {
        Some(schema) => UpstreamEvent {
            event_type: event_type.to_string(),
            schema: Some(guess.clone()),
            fields: to_fields(&schema.fields, inherited, decls, notes),
            unparsed: Some(schema.error.clone().unwrap_or_else(|| {
                format!("{guess} does not declare a recognisable `type` literal")
            })),
        },
        None => UpstreamEvent {
            event_type: event_type.to_string(),
            schema: None,
            fields: Vec::new(),
            unparsed: Some("no Zod schema found for this event type".to_string()),
        },
    }
}

/// Parses `export enum EventType { ... }`.
///
/// Returns the member-name -> wire-value map (so `EventType.RAW` can be
/// resolved) and the wire values in declaration order.
fn parse_event_type_enum(src: &str) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
    let at = src
        .find("enum EventType")
        .ok_or("`enum EventType` not found in the upstream source")?;
    let open = src[at..]
        .find('{')
        .map(|i| at + i)
        .ok_or("`enum EventType` has no body")?;
    let close = match_delim(src, open).ok_or("`enum EventType` body is unbalanced")?;

    let mut idents = BTreeMap::new();
    let mut values = Vec::new();
    for entry in split_top_level(&src[open + 1..close], ',') {
        let Some((ident, literal)) = entry.split_once('=') else {
            return Err(format!("unrecognised `EventType` member: `{entry}`"));
        };
        let ident = ident.trim();
        let literal = literal.trim();
        let value = literal
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .ok_or_else(|| format!("`EventType.{ident}` is not a string literal: `{literal}`"))?;
        idents.insert(ident.to_string(), value.to_string());
        values.push(value.to_string());
    }
    if values.is_empty() {
        return Err("`enum EventType` is empty".to_string());
    }
    Ok((idents, values))
}

/// Every `const NAME = <expr>;` in the file, mapped to its expression text.
fn collect_const_decls(src: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut at = 0usize;
    while let Some(found) = src[at..].find("const ") {
        let kw = at + found;
        at = kw + "const ".len();
        // Only statement-position `const`, not `x.const` or `myconst `.
        if src[..kw]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.')
        {
            continue;
        }
        let name = read_ident(src, at);
        if name.is_empty() {
            continue;
        }
        let after = at + name.len();
        let Some(eq) = src[after..].find('=').map(|i| after + i) else {
            continue;
        };
        if !src[after..eq].trim().is_empty() {
            continue;
        }
        let expr_start = eq + 1;
        let end = find_top_level(&src[expr_start..], ";")
            .map(|i| expr_start + i)
            .unwrap_or(src.len());
        out.insert(name.to_string(), src[expr_start..end].trim().to_string());
        at = end;
    }
    out
}

/// A Zod object schema reduced to an ordered list of `(field, value expression)`.
#[derive(Debug, Clone, Default)]
struct ParsedSchema {
    fields: Vec<(String, String)>,
    /// Set when part of the expression was not understood. Fields parsed before
    /// that point are kept, but callers must treat them as untrustworthy.
    error: Option<String>,
}

/// Resolves a schema const to its field list, following `extend`/`omit`/`pick`
/// chains through other consts.
fn resolve(name: &str, decls: &BTreeMap<String, String>, stack: &mut Vec<String>) -> ParsedSchema {
    if stack.iter().any(|n| n == name) {
        return ParsedSchema {
            fields: Vec::new(),
            error: Some(format!("`{name}` is defined in terms of itself")),
        };
    }
    let Some(expr) = decls.get(name) else {
        return ParsedSchema {
            fields: Vec::new(),
            error: Some(format!("`{name}` is not declared in this file")),
        };
    };
    stack.push(name.to_string());
    let parsed = parse_expr(expr, decls, stack);
    stack.pop();
    parsed
}

/// Parses `z.object({...})` or `OtherSchema`, followed by a chain of
/// `.extend()` / `.omit()` / `.pick()` / no-op modifiers.
fn parse_expr(
    expr: &str,
    decls: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
) -> ParsedSchema {
    let expr = expr.trim();
    let (mut schema, mut rest, head_is_z) = match parse_primary(expr, decls, stack) {
        Ok(parts) => parts,
        Err(error) => {
            return ParsedSchema {
                fields: Vec::new(),
                error: Some(error),
            };
        }
    };
    let mut first_call = true;

    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            return schema;
        }
        let Some(after_dot) = rest.strip_prefix('.') else {
            schema.error = Some(format!("unexpected trailing expression `{}`", brief(rest)));
            return schema;
        };
        let method = read_ident(after_dot, 0);
        let Some(open) = after_dot[method.len()..]
            .find('(')
            .map(|i| method.len() + i)
        else {
            schema.error = Some(format!("`.{method}` is not a call"));
            return schema;
        };
        let Some(close) = match_delim(after_dot, open) else {
            schema.error = Some(format!("`.{method}(` is unbalanced"));
            return schema;
        };
        let arg = after_dot[open + 1..close].trim();
        rest = &after_dot[close + 1..];
        let is_head_call = first_call && head_is_z;
        first_call = false;

        match method {
            // `z.object({...})` — the head of a from-scratch schema.
            "object" if is_head_call => match parse_object_literal(arg) {
                Ok(fields) => schema.fields = fields,
                Err(error) => {
                    schema.error = Some(error);
                    return schema;
                }
            },
            _ if is_head_call => {
                schema.error = Some(format!("unsupported schema head `z.{method}()`"));
                return schema;
            }
            "extend" => match parse_object_literal(arg) {
                Ok(fields) => {
                    for (key, value) in fields {
                        match schema.fields.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => slot.1 = value,
                            None => schema.fields.push((key, value)),
                        }
                    }
                }
                Err(error) => {
                    schema.error = Some(error);
                    return schema;
                }
            },
            "omit" | "pick" => match parse_object_literal(arg) {
                Ok(keys) => {
                    let keys: Vec<String> = keys.into_iter().map(|(k, _)| k).collect();
                    let keep = method == "pick";
                    schema.fields.retain(|(k, _)| keys.contains(k) == keep);
                }
                Err(error) => {
                    schema.error = Some(error);
                    return schema;
                }
            },
            // Modifiers that change validation but not the field set.
            "passthrough" | "strict" | "strip" | "describe" | "catchall" | "readonly" => {}
            _ => {
                schema.error = Some(format!("unsupported schema modifier `.{method}()`"));
                return schema;
            }
        }
    }
}

/// Splits the head of a schema expression from the method chain that follows.
///
/// The third element of the tuple says whether the head was the bare `z`
/// namespace, in which case the first call in the chain is `z.object({...})`
/// rather than a modifier. Upstream writes both `z.object({...}).passthrough()`
/// and, after prettier wraps it, `z\n  .object({...})\n  .passthrough()`.
fn parse_primary<'a>(
    expr: &'a str,
    decls: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
) -> Result<(ParsedSchema, &'a str, bool), String> {
    let ident = read_ident(expr, 0);
    if ident.is_empty() {
        return Err(format!("unsupported schema expression `{}`", brief(expr)));
    }
    if ident == "z" {
        return Ok((ParsedSchema::default(), &expr[1..], true));
    }
    Ok((resolve(ident, decls, stack), &expr[ident.len()..], false))
}

/// Parses `{ key: <expr>, "quoted": <expr> }` into ordered pairs.
fn parse_object_literal(arg: &str) -> Result<Vec<(String, String)>, String> {
    let arg = arg.trim();
    if !arg.starts_with('{') {
        return Err(format!(
            "expected an object literal, found `{}`",
            brief(arg)
        ));
    }
    let close = match_delim(arg, 0).ok_or_else(|| "object literal is unbalanced".to_string())?;
    let mut out = Vec::new();
    for entry in split_top_level(&arg[1..close], ',') {
        if entry.starts_with("...") {
            return Err(format!(
                "object spread is not supported: `{}`",
                brief(entry)
            ));
        }
        let colon = find_top_level(entry, ":")
            .ok_or_else(|| format!("field `{}` has no value", brief(entry)))?;
        let key = entry[..colon].trim().trim_matches(['"', '\''].as_slice());
        out.push((key.to_string(), entry[colon + 1..].trim().to_string()));
    }
    Ok(out)
}

/// `z.literal(EventType.RAW)` -> `RAW`; `z.literal("RAW")` -> `RAW`.
fn event_type_literal(value: &str) -> Option<String> {
    let inner = value.strip_prefix("z.literal(")?.trim_end();
    let inner = inner.strip_suffix(')')?.trim();
    if let Some(member) = inner.strip_prefix("EventType.") {
        return Some(read_ident(member, 0).to_string());
    }
    inner
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .map(str::to_string)
}

/// Turns `(field, value expression)` pairs into fields, dropping the ones every
/// event inherits and deciding required-ness from the Zod chain.
fn to_fields(
    pairs: &[(String, String)],
    inherited: &[String],
    decls: &BTreeMap<String, String>,
    notes: &mut Vec<String>,
) -> Vec<Field> {
    pairs
        .iter()
        .filter(|(name, _)| !inherited.iter().any(|i| i == name))
        .map(|(name, value)| {
            let (required, note) = field_optionality(value, decls);
            if let Some(note) = note.filter(|n| !notes.contains(n)) {
                notes.push(note);
            }
            Field {
                name: name.clone(),
                required,
            }
        })
        .collect()
}

/// Whether a field is required, and how that was decided when the Zod chain
/// could not decide it.
///
/// The chain is the reliable signal. A field whose value is nothing but an
/// identifier has no chain to read — `metadata: OptionalMetadataSchema` — so
/// the identifier is followed to its declaration when this file makes one, and
/// otherwise its name is all there is to go on. Upstream's convention is that
/// such a const says what it is, and reading the name beats the alternative
/// this replaces: an imported optional schema used to be recorded as required,
/// which is how `BaseEvent.metadata` would have entered the baseline as a
/// required field nobody agreed to. The reading is reported as a note, so the
/// human accepting a refresh can see it was a reading and not a parse.
fn field_optionality(value: &str, decls: &BTreeMap<String, String>) -> (bool, Option<String>) {
    let mut expr = value.trim().to_string();
    let mut followed: Vec<String> = Vec::new();
    loop {
        if !is_required(&expr) {
            return (false, None);
        }
        let Some(ident) = bare_ident(&expr) else {
            return (true, None);
        };
        match decls.get(ident) {
            Some(declared) if !followed.iter().any(|f| f == ident) => {
                followed.push(ident.to_string());
                expr = declared.clone();
            }
            _ => {
                let optional = ident.starts_with("Optional");
                return (
                    !optional,
                    Some(format!(
                        "`{ident}` is not declared in this file, so it was read as {} from \
                         its name",
                        optionality(!optional)
                    )),
                );
            }
        }
    }
}

/// The whole value when it is one identifier and nothing else, as in
/// `metadata: OptionalMetadataSchema`.
fn bare_ident(value: &str) -> Option<&str> {
    let value = value.trim();
    let ident = read_ident(value, 0);
    (!ident.is_empty() && ident.len() == value.len()).then_some(ident)
}

/// A field is optional when its own chain carries `.optional()` or `.default()`.
///
/// Depth matters: `z.array(z.string().optional())` is a required field holding
/// optional elements.
fn is_required(value: &str) -> bool {
    find_top_level(value, ".optional()").is_none() && find_top_level(value, ".default(").is_none()
}

/// Shortens an expression for an error message.
fn brief(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 60 {
        let cut: String = flat.chars().take(57).collect();
        format!("{cut}...")
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
import { z } from "zod";

const RoleSchema = z.union([z.literal("user"), z.literal("assistant")]);

export enum EventType {
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  /** @deprecated */
  THINKING_END = "THINKING_END",
  RAW = "RAW",
  ORPHAN = "ORPHAN",
}

export const BaseEventSchema = z
  .object({
    type: z.nativeEnum(EventType),
    timestamp: z.number().optional(),
    rawEvent: z.any().optional(),
  })
  .passthrough();

export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: RoleSchema.default("assistant"),
  name: z.string().optional(),
});

export const ThinkingEndEventSchema = TextMessageStartEventSchema.omit({
  role: true,
  name: true,
}).extend({
  type: z.literal(EventType.THINKING_END),
});

export const RawEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RAW),
  event: z.any(),
}).superRefine((v) => v);
"#;

    fn event<'a>(up: &'a Upstream, ty: &str) -> &'a UpstreamEvent {
        up.events.iter().find(|e| e.event_type == ty).unwrap()
    }

    #[test]
    fn reads_event_types_in_order() {
        let up = extract(SAMPLE).unwrap();
        assert_eq!(
            up.event_types,
            ["TEXT_MESSAGE_START", "THINKING_END", "RAW", "ORPHAN"]
        );
    }

    #[test]
    fn base_fields_are_inherited_not_repeated() {
        let up = extract(SAMPLE).unwrap();
        assert_eq!(
            up.base_fields,
            [
                Field {
                    name: "timestamp".into(),
                    required: false
                },
                Field {
                    name: "rawEvent".into(),
                    required: false
                },
            ]
        );
        let start = event(&up, "TEXT_MESSAGE_START");
        assert_eq!(
            start.fields,
            [
                Field {
                    name: "messageId".into(),
                    required: true
                },
                Field {
                    name: "role".into(),
                    required: false
                },
                Field {
                    name: "name".into(),
                    required: false
                },
            ]
        );
        assert_eq!(start.schema.as_deref(), Some("TextMessageStartEventSchema"));
        assert!(start.unparsed.is_none());
    }

    #[test]
    fn follows_omit_and_extend_through_another_schema() {
        let up = extract(SAMPLE).unwrap();
        let thinking = event(&up, "THINKING_END");
        assert_eq!(
            thinking.fields,
            [Field {
                name: "messageId".into(),
                required: true
            }]
        );
        assert!(thinking.unparsed.is_none());
    }

    #[test]
    fn unknown_modifier_is_a_warning_not_a_loss_of_the_event() {
        let up = extract(SAMPLE).unwrap();
        let raw = event(&up, "RAW");
        assert_eq!(raw.schema.as_deref(), Some("RawEventSchema"));
        assert!(raw.unparsed.as_deref().unwrap().contains("superRefine"));
    }

    #[test]
    fn event_type_without_a_schema_is_a_warning() {
        let up = extract(SAMPLE).unwrap();
        let orphan = event(&up, "ORPHAN");
        assert_eq!(orphan.schema, None);
        assert!(orphan.unparsed.is_some());
    }

    #[test]
    fn missing_enum_is_a_hard_error() {
        assert!(extract("export const x = 1;").is_err());
    }

    /// The gap this closes: `metadata: OptionalMetadataSchema` is imported, so
    /// there is no `.optional()` to read, and it used to be recorded as a
    /// required field on every event.
    const IMPORTED: &str = r#"
import { z } from "zod";
import { OptionalMetadataSchema } from "./metadata";
import { StateSchema } from "./types";

const MaybeName = z.string().optional();

export enum EventType {
  STATE_SNAPSHOT = "STATE_SNAPSHOT",
}

export const BaseEventSchema = z
  .object({
    type: z.nativeEnum(EventType),
    metadata: OptionalMetadataSchema,
  })
  .passthrough();

export const StateSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_SNAPSHOT),
  snapshot: StateSchema,
  name: MaybeName,
});
"#;

    #[test]
    fn an_imported_optional_schema_is_read_as_optional() {
        let up = extract(IMPORTED).unwrap();
        assert_eq!(
            up.base_fields,
            [Field {
                name: "metadata".into(),
                required: false
            }]
        );
        assert!(
            up.notes
                .iter()
                .any(|n| n.contains("OptionalMetadataSchema") && n.contains("read as optional")),
            "{:?}",
            up.notes
        );
    }

    #[test]
    fn an_imported_schema_without_the_prefix_stays_required() {
        let up = extract(IMPORTED).unwrap();
        let snapshot = event(&up, "STATE_SNAPSHOT");
        assert_eq!(
            snapshot.fields[0],
            Field {
                name: "snapshot".into(),
                required: true
            }
        );
        assert!(
            up.notes
                .iter()
                .any(|n| n.contains("StateSchema") && n.contains("read as required")),
            "{:?}",
            up.notes
        );
    }

    /// A const this file declares is followed rather than guessed at, and
    /// following it is not worth a note.
    #[test]
    fn a_locally_declared_schema_is_followed_not_guessed() {
        let up = extract(IMPORTED).unwrap();
        let snapshot = event(&up, "STATE_SNAPSHOT");
        assert_eq!(
            snapshot.fields[1],
            Field {
                name: "name".into(),
                required: false
            }
        );
        assert!(!up.notes.iter().any(|n| n.contains("MaybeName")));
    }

    #[test]
    fn a_note_is_made_once_however_many_fields_share_the_schema() {
        let up = extract(IMPORTED).unwrap();
        assert_eq!(up.notes.len(), 2, "{:?}", up.notes);
    }
}
