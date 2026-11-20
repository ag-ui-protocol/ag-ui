//! The upstream AG-UI 1.0 conformance corpus, run as one table.
//!
//! One row per stream under `../../../../../spec/1.0/conformance/streams`, plus the local
//! streams beside it. Each row is held to the `expect` the stream itself
//! declares, on every lane that can observe it:
//!
//! - **pipeline** — the standalone pieces driven by hand: the SSE decoder and
//!   compatibility boundary ([`enforce_events`]), [`ChunkNormalizer`],
//!   [`Verifier`], [`Applier`]. Its events are the expanded ones, so it also
//!   takes the corpus's `typescript` override, which is written for a lane
//!   that expands chunks. It sends no request.
//! - **thread** — a [`Thread`] reading the same bytes through a transport.
//!   Its events are what `on_event` observes, before expansion.
//! - **producer** — the server-side [`EventVerifier`], for a stream a typed
//!   producer could have written: every event decodes without the boundary,
//!   loses nothing on the way, and none is a retired `THINKING_*` shape.
//!
//! A lane that does not produce the declared outcome is listed in [`pins`]
//! with the reason and the issue that resolves it, and is held to exactly what
//! it does today instead. A pin whose declared expectation has started to hold
//! fails, so closing a gap means deleting the pin.
//!
//! A local stream may say more than the corpus vocabulary allows, about the
//! thread lane alone: which run the request asks for (`input.runId`), and in
//! `expect` how the request went (`end`), each run on the stream (`runs`),
//! the interrupts left pending (`pendingInterrupts`) and every diagnostic
//! (`diagnostics`).
//!
//! `cargo test -p ag-ui --all-features --test conformance_1_0 -- --nocapture`
//! prints the table.

#![cfg(all(
    feature = "client",
    feature = "sse",
    feature = "server",
    feature = "verify"
))]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ag_ui::client::apply::Applier;
use ag_ui::client::transport::{
    Transport, TransportFuture, TransportStream, decode_raw_events, enforce_events,
};
use ag_ui::client::{ChunkNormalizer, Error, RunEnd, Thread, Verifier};
use ag_ui::server::EventVerifier;
use ag_ui::{Event, EventType, Message, RunAgentInput, Tool};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

// ---- the corpus ---------------------------------------------------------

struct Stream {
    name: String,
    /// Not from upstream: a stream this repository adds.
    local: bool,
    doc: Value,
}

impl Stream {
    fn events(&self) -> &[Value] {
        self.doc["stream"].as_array().expect("stream is a list")
    }

    /// The stream as a producer would have sent it: one SSE frame per event.
    fn body(&self) -> Vec<u8> {
        self.events()
            .iter()
            .map(|event| ag_ui::encode::sse::frame(&event.to_string()))
            .collect::<String>()
            .into_bytes()
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

fn json_files(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("cannot list {}: {error}", dir.display()))
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect()
}

fn load(dir: &Path, local: bool) -> Vec<Stream> {
    json_files(dir)
        .into_iter()
        .map(|file| {
            let doc = read_json(&dir.join(&file));
            let name = file.trim_end_matches(".json").to_owned();
            assert_eq!(doc["name"], name, "{file}: `name` must equal the file name");
            Stream { name, local, doc }
        })
        .collect()
}

/// Check every stream in this checkout's frozen corpus, then the Rust cases.
fn corpus() -> Vec<Stream> {
    let streams =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/conformance/streams");
    let manifest: BTreeSet<String> = std::fs::read_to_string(streams.join("MANIFEST.txt"))
        .expect("the protocol manifest")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect();
    assert_eq!(json_files(&streams), manifest, "official stream manifest");
    // The reference client deliberately fails on an unknown role. The Rust
    // replacement in local/streams verifies the specified tolerant behavior.
    let mut corpus = load(&streams, false);
    let count = corpus.len();
    corpus.retain(|stream| stream.name != "unknown-enum-value-role-fatal");
    assert_eq!(
        corpus.len() + 1,
        count,
        "revisit the reference-client exception"
    );
    corpus.extend(load(&fixtures().join("local/streams"), true));
    corpus
}

// ---- lanes --------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Lane {
    Pipeline,
    Thread,
    Producer,
}

impl Lane {
    const ALL: [Self; 3] = [Self::Pipeline, Self::Thread, Self::Producer];

    const fn name(self) -> &'static str {
        match self {
            Self::Pipeline => "pipeline",
            Self::Thread => "thread",
            Self::Producer => "producer",
        }
    }
}

/// What a lane observed. `None` is a key the lane cannot see.
#[derive(Default)]
struct Seen {
    /// The lane's rejection, in its own words; `None` when it read the stream.
    rejected: Option<String>,
    /// The message of a `RUN_ERROR` the stream delivered.
    run_error: Option<String>,
    events: Option<Vec<Value>>,
    warnings: Option<Vec<String>>,
    messages: Option<Vec<Value>>,
    state: Option<Value>,
    request: Option<Value>,
    /// Thread only: `RunEnd` and every diagnostic as `[kind, message]`.
    end: Option<Value>,
    diagnostics: Option<Vec<(String, String)>>,
    /// Thread only: each run on the stream, as `runId`, `requested`, the
    /// name of its `RunEnd` as `end` and the whole of it as `detail`.
    runs: Option<Vec<Value>>,
    /// Thread only: the ids of the interrupts left pending.
    pending_interrupts: Option<Vec<String>>,
    /// Producer only: the index of the rejected event.
    at: Option<usize>,
}

fn to_values<T: serde::Serialize>(items: &[T]) -> Vec<Value> {
    items
        .iter()
        .map(|item| serde_json::to_value(item).expect("protocol types serialize"))
        .collect()
}

/// Decoder, compatibility boundary, chunk expansion, verification and
/// application, each called by hand in the order `Thread` runs them.
async fn pipeline(stream: &Stream) -> Seen {
    // What the boundary removed or translated, then any patch that did not
    // apply: the same things a `Thread` reports without failing the run.
    let mut warnings = Vec::new();
    let raw = decode_raw_events(stream::iter([Ok::<_, std::io::Error>(stream.body())]));
    let decoded: Vec<Result<Event, Error>> = enforce_events(raw, |warning| warnings.push(warning))
        .collect()
        .await;

    let mut normalizer = ChunkNormalizer::new();
    let mut verifier = Verifier::new();
    let mut applier = Applier::new();
    let mut delivered = Vec::new();
    let mut run_error = None;
    let mut expanded = Vec::new();

    let read = || -> Result<(), Error> {
        let mut accept = |events: &mut Vec<Event>| -> Result<(), Error> {
            for event in events.drain(..) {
                verifier.verify(&event)?;
                match applier.apply(&event) {
                    Ok(_) => {}
                    Err(error @ Error::Patch { .. }) => warnings.push(error.to_string()),
                    Err(error) => return Err(error),
                }
                if let Event::RunError(failed) = &event {
                    run_error = Some(failed.message.clone());
                }
                delivered.push(event);
            }
            Ok(())
        };
        for event in decoded {
            let normalized = normalizer.normalize(event?, &mut expanded);
            accept(&mut expanded)?;
            normalized?;
        }
        normalizer.finish(&mut expanded);
        accept(&mut expanded)?;
        verifier.finish()
    };
    let rejected = read().err().map(|error| error.to_string());

    Seen {
        rejected,
        run_error,
        events: Some(to_values(&delivered)),
        warnings: Some(warnings),
        messages: Some(to_values(applier.messages())),
        state: Some(applier.state().clone()),
        ..Seen::default()
    }
}

/// Serves a stream's bytes, and records the request it was asked with.
///
/// Not `ReplayTransport`: that holds typed events, and a third of the corpus
/// is about what cannot be one — an unknown event, a malformed field.
#[derive(Clone)]
struct Wire {
    body: Arc<Vec<u8>>,
    requests: Arc<Mutex<Vec<RunAgentInput>>>,
}

impl Wire {
    fn chunks(
        &self,
        input: RunAgentInput,
    ) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> + use<> {
        self.requests.lock().unwrap().push(input);
        stream::iter([Ok(self.body.to_vec())])
    }
}

impl Transport for Wire {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let chunks = self.chunks(input);
        Box::pin(async move { Ok(TransportStream::json(decode_raw_events(chunks))) })
    }
}

/// A `Thread` asked to run once, with the fixture's `input` as its history
/// and the stream's own ids as the request's: the thread id every run
/// carries, and the run id of the last run. AG-UI 1.0, `basic/run-input`:
/// "The run it requests is the exchange's last", so a stream of several runs
/// stands for a replay and then the requested run. A local stream that puts
/// a run after the requested one names the one asked for in `input.runId`.
async fn thread(stream: &Stream) -> Seen {
    let started = || {
        stream
            .events()
            .iter()
            .filter(|event| event["type"] == "RUN_STARTED")
    };
    let id = |event: Option<&Value>, key: &str| {
        event
            .and_then(|event| event[key].as_str())
            .map(str::to_owned)
    };
    let wire = Wire {
        body: Arc::new(stream.body()),
        requests: Arc::default(),
    };

    let mut builder = Thread::<_>::builder(
        wire.clone(),
        id(started().next(), "threadId").unwrap_or_else(|| format!("t-{}", stream.name)),
    );
    let input = &stream.doc["input"];
    let requested = id(Some(input), "runId").or_else(|| id(started().next_back(), "runId"));
    if let Some(messages) = input.get("messages") {
        let messages: Vec<Message> =
            serde_json::from_value(messages.clone()).expect("the fixture's input messages");
        builder = builder.messages(messages);
    }
    if let Some(tools) = input.get("tools") {
        let tools: Vec<Tool> =
            serde_json::from_value(tools.clone()).expect("the fixture's input tools");
        builder = builder.tools(tools);
    }
    // `client.maxProtocolVersion` pins a peer older than 1.0, which predates
    // the version declaration.
    if stream.doc.get("client").is_some() {
        builder = builder.protocol_version(None);
    }
    let mut thread = builder.build().expect("the thread builds");
    if let Some(run_id) = requested {
        thread.set_next_run_id(run_id);
    }
    let observed = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&observed);
    thread.on_event(move |event| sink.lock().unwrap().push(event.clone()));

    let report = thread
        .run()
        .expect("nothing is pending on a new thread")
        .collect_report()
        .await;

    let diagnostics: Vec<(String, String)> = report
        .diagnostics
        .iter()
        .map(|diagnostic| (diagnostic.kind.to_owned(), diagnostic.message.clone()))
        .collect();
    let of_kind = |kinds: &[&str]| -> Vec<String> {
        diagnostics
            .iter()
            .filter(|(kind, _)| kinds.contains(&kind.as_str()))
            .map(|(_, message)| message.clone())
            .collect()
    };
    // What ends the run as a rejection, what a run reports about itself, and
    // everything else: the run carried on.
    let fatal = ["protocol", "decode", "transport"];
    let rejected = of_kind(&fatal).into_iter().next();
    let run_error = of_kind(&["run"]).into_iter().next();
    let warnings = diagnostics
        .iter()
        .filter(|(kind, _)| !fatal.contains(&kind.as_str()) && kind != "run")
        .map(|(_, message)| message.clone())
        .collect();
    let end = serde_json::to_value(&report.end).expect("RunEnd serializes");
    let failed = |end: &RunEnd| matches!(end, RunEnd::Failed { .. });
    assert_eq!(
        rejected.is_some() || run_error.is_some(),
        failed(&report.end) || report.runs.iter().any(|run| failed(&run.end)),
        "{}: something on a thread's stream ends as Failed exactly when the stream was \
         rejected or a run reported RUN_ERROR: {end} {:?} {diagnostics:?}",
        stream.name,
        report.runs
    );
    let runs = report
        .runs
        .iter()
        .map(|run| {
            let detail = serde_json::to_value(&run.end).expect("RunEnd serializes");
            // A variant with fields serializes as `{"Name": {…}}`, one
            // without as `"Name"`.
            let name = match &detail {
                Value::Object(variant) => variant.keys().next().cloned(),
                other => other.as_str().map(str::to_owned),
            };
            json!({
                "runId": run.run_id,
                "requested": run.requested,
                "end": name,
                "detail": detail,
            })
        })
        .collect();
    let pending_interrupts = thread
        .interrupts()
        .iter()
        .map(|interrupt| interrupt.id.clone())
        .collect();
    let requests = wire.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        1,
        "{}: one request, however many runs answer it",
        stream.name
    );

    Seen {
        rejected,
        run_error,
        events: Some(to_values(&observed.lock().unwrap())),
        warnings: Some(warnings),
        messages: Some(to_values(thread.messages())),
        state: Some(thread.raw_state().clone()),
        request: Some(serde_json::to_value(&requests[0]).expect("the request serializes")),
        end: Some(end),
        diagnostics: Some(diagnostics),
        runs: Some(runs),
        pending_interrupts: Some(pending_interrupts),
        at: None,
    }
}

/// The server-side verifier over the stream as typed events, or why the
/// stream is not one a typed producer could have written.
fn producer(stream: &Stream) -> Result<Seen, &'static str> {
    let mut events = Vec::new();
    for wire in stream.events() {
        let Ok(event) = serde_json::from_value::<Event>(wire.clone()) else {
            return Err("an event does not decode");
        };
        if event.event_type().as_str().starts_with("THINKING_") {
            return Err("a retired shape");
        }
        let written = serde_json::to_value(&event).expect("events serialize");
        if subset(wire, &written, "").is_err() {
            return Err("an event carries what the types do not");
        }
        events.push(event);
    }

    let mut verifier = EventVerifier::new();
    let mut seen = Seen::default();
    for (index, event) in events.iter().enumerate() {
        if let Err(error) = verifier.observe(event) {
            seen.rejected = Some(format!("{}: {}", error.rule.as_str(), error.detail));
            seen.at = Some(index);
            break;
        }
        if let Event::RunError(failed) = event {
            seen.run_error = Some(failed.message.clone());
        }
    }
    Ok(seen)
}

// ---- expectations -------------------------------------------------------

/// `expected` is a subset of `actual`: objects on the keys named, lists
/// element by element at the same length, everything else by equality.
fn subset(expected: &Value, actual: &Value, at: &str) -> Result<(), String> {
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => {
            for (key, expected) in expected {
                let at = format!("{at}/{key}");
                match actual.get(key) {
                    Some(actual) => subset(expected, actual, &at)?,
                    None => return Err(format!("{at} is absent")),
                }
            }
            Ok(())
        }
        (Value::Array(expected), Value::Array(actual)) => {
            if expected.len() != actual.len() {
                return Err(format!(
                    "{at} holds {} item(s), expected {}: {}",
                    actual.len(),
                    expected.len(),
                    Value::Array(actual.clone())
                ));
            }
            for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                subset(expected, actual, &format!("{at}/{index}"))?;
            }
            Ok(())
        }
        _ if expected == actual => Ok(()),
        _ => Err(format!("{at} is {actual}, expected {expected}")),
    }
}

/// Resolves `"<index>.<dotted path>"` inside a list.
fn lookup<'a>(items: &'a [Value], path: &str) -> Option<&'a Value> {
    let mut segments = path.split('.');
    let mut value = items.get(segments.next()?.parse::<usize>().ok()?)?;
    for segment in segments {
        value = match value {
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            other => other.get(segment)?,
        };
    }
    Some(value)
}

fn types(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .map(|event| event["type"].as_str().unwrap_or("?"))
        .collect()
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("a list of strings")
        .iter()
        .map(|item| item.as_str().expect("a string"))
        .collect()
}

/// Everything in `expect` the lane does not satisfy. A key the lane cannot
/// see is skipped, unless `strict`: a pin has to be checkable.
fn mismatches(expect: &Value, seen: &Seen, strict: bool) -> Vec<String> {
    let mut out = Vec::new();
    let unseen = |key: &str, out: &mut Vec<String>| {
        if strict {
            out.push(format!("{key}: this lane cannot observe it"));
        }
    };
    for (key, expected) in expect.as_object().expect("expect is an object") {
        match key.as_str() {
            "outcome" => {
                let actual = if seen.rejected.is_some() {
                    "failed"
                } else {
                    "completed"
                };
                if expected != actual {
                    out.push(format!(
                        "outcome: {actual}, expected {expected}{}",
                        seen.rejected
                            .as_ref()
                            .map(|error| format!(" ({error})"))
                            .unwrap_or_default()
                    ));
                }
            }
            "errorContains" => {
                let words = expected.as_str().expect("a string");
                match &seen.rejected {
                    Some(error) if error.contains(words) => {}
                    Some(error) => {
                        out.push(format!("errorContains: {words:?} is not in {error:?}"))
                    }
                    None => out.push(format!(
                        "errorContains: nothing was rejected, expected {words:?}"
                    )),
                }
            }
            "runError" => {
                let holds = match (expected, &seen.run_error) {
                    (Value::Bool(true), Some(_)) => true,
                    (Value::String(words), Some(message)) => message.contains(words.as_str()),
                    _ => false,
                };
                if !holds {
                    out.push(format!(
                        "runError: {:?}, expected {expected}",
                        seen.run_error
                    ));
                }
            }
            "eventTypes" | "eventTypesAbsent" | "eventPaths" | "eventAbsentPaths" => {
                let Some(events) = &seen.events else {
                    unseen(key, &mut out);
                    continue;
                };
                match key.as_str() {
                    "eventTypes" => {
                        if types(events) != strings(expected) {
                            out.push(format!(
                                "eventTypes: {:?}, expected {expected}",
                                types(events)
                            ));
                        }
                    }
                    "eventTypesAbsent" => {
                        for absent in strings(expected) {
                            if types(events).contains(&absent) {
                                out.push(format!("eventTypesAbsent: {absent} was delivered"));
                            }
                        }
                    }
                    "eventPaths" => {
                        for (path, expected) in expected.as_object().expect("an object") {
                            match lookup(events, path) {
                                Some(actual) if actual == expected => {}
                                actual => out.push(format!(
                                    "eventPaths: {path} is {actual:?}, expected {expected}"
                                )),
                            }
                        }
                    }
                    _ => {
                        for path in strings(expected) {
                            if let Some(actual) = lookup(events, path) {
                                out.push(format!("eventAbsentPaths: {path} is {actual}"));
                            }
                        }
                    }
                }
            }
            "warnings" | "noWarnings" => {
                let Some(warnings) = &seen.warnings else {
                    unseen(key, &mut out);
                    continue;
                };
                if key == "warnings" {
                    for words in strings(expected) {
                        if !warnings.iter().any(|warning| warning.contains(words)) {
                            out.push(format!("warnings: {words:?} is in none of {warnings:?}"));
                        }
                    }
                } else if expected == &Value::Bool(true) && !warnings.is_empty() {
                    out.push(format!("noWarnings: {warnings:?}"));
                }
            }
            "messageCount" | "messages" | "messageAbsentPaths" => {
                let Some(messages) = &seen.messages else {
                    unseen(key, &mut out);
                    continue;
                };
                match key.as_str() {
                    "messageCount" => {
                        if expected.as_u64() != Some(messages.len() as u64) {
                            out.push(format!(
                                "messageCount: {}, expected {expected}: {}",
                                messages.len(),
                                Value::Array(messages.clone())
                            ));
                        }
                    }
                    "messages" => {
                        if let Err(why) = subset(expected, &Value::Array(messages.clone()), "") {
                            out.push(format!("messages: {why}"));
                        }
                    }
                    _ => {
                        for path in strings(expected) {
                            if let Some(actual) = lookup(messages, path) {
                                out.push(format!("messageAbsentPaths: {path} is {actual}"));
                            }
                        }
                    }
                }
            }
            "state" => match &seen.state {
                Some(state) => {
                    if let Err(why) = subset(expected, state, "") {
                        out.push(format!("state: {why}"));
                    }
                }
                None => unseen(key, &mut out),
            },
            "request" | "requestAbsentPaths" => {
                let Some(request) = &seen.request else {
                    unseen(key, &mut out);
                    continue;
                };
                if key == "request" {
                    if let Err(why) = subset(expected, request, "") {
                        out.push(format!("request: {why}"));
                    }
                } else {
                    let request = std::slice::from_ref(request);
                    for path in strings(expected) {
                        if let Some(actual) = lookup(request, &format!("0.{path}")) {
                            out.push(format!("requestAbsentPaths: {path} is {actual}"));
                        }
                    }
                }
            }

            // Not corpus vocabulary: what a pin needs to say exactly, and
            // what a local stream says about a thread.
            "end" => match &seen.end {
                Some(end) => {
                    if let Err(why) = subset(expected, end, "") {
                        out.push(format!("end: {why}"));
                    }
                }
                None => unseen(key, &mut out),
            },
            "runs" => match &seen.runs {
                Some(runs) => {
                    if let Err(why) = subset(expected, &Value::Array(runs.clone()), "") {
                        out.push(format!("runs: {why}"));
                    }
                }
                None => unseen(key, &mut out),
            },
            "pendingInterrupts" => match &seen.pending_interrupts {
                Some(pending) => {
                    if strings(expected) != *pending {
                        out.push(format!(
                            "pendingInterrupts: {pending:?}, expected {expected}"
                        ));
                    }
                }
                None => unseen(key, &mut out),
            },
            "diagnostics" => match &seen.diagnostics {
                Some(diagnostics) => {
                    let expected = expected.as_array().expect("a list of [kind, words]");
                    let holds = expected.len() == diagnostics.len()
                        && expected
                            .iter()
                            .zip(diagnostics)
                            .all(|(expected, (kind, message))| {
                                expected[0] == kind.as_str()
                                    && message.contains(expected[1].as_str().expect("words"))
                            });
                    if !holds {
                        out.push(format!(
                            "diagnostics: {diagnostics:?}, expected {expected:?}"
                        ));
                    }
                }
                None => unseen(key, &mut out),
            },
            "at" => {
                if expected.as_u64() != seen.at.map(|at| at as u64) {
                    out.push(format!("at: {:?}, expected {expected}", seen.at));
                }
            }
            other => out.push(format!("{other}: not a key this runner reads")),
        }
    }
    out
}

/// The corpus quotes the TypeScript client's wording in `errorContains`. One
/// row per stream it declares `failed`: the same rejection in this SDK's words
/// on the client lanes, and the rule the server verifier names for it.
const REJECTIONS: &[(&str, &str, &str)] = &[
    (
        "chunk-after-explicit-start-fatal",
        r#"TEXT_MESSAGE_START for message "chunk-after-start-m1", which is already open"#,
        "duplicate-start",
    ),
    (
        "chunk-conflicting-role-fatal",
        "does not match the open stream's role",
        "malformed-chunk",
    ),
    (
        "chunk-conflicting-tool-name-fatal",
        "does not match the open stream's toolCallName",
        "malformed-chunk",
    ),
    (
        "content-without-start-fatal",
        r#"TEXT_MESSAGE_CONTENT for message "orphan-content-m1", which is not open"#,
        "not-open",
    ),
    (
        "custom-closes-chunk-stream-fatal",
        "TEXT_MESSAGE_CHUNK carries no messageId and no message is open",
        "malformed-chunk",
    ),
    (
        "event-after-run-error-fatal",
        "RUN_ERROR arrived after the run had already finished",
        "run-ended",
    ),
    (
        "event-after-run-finished-fatal",
        "TEXT_MESSAGE_START arrived after the run had already finished",
        "run-ended",
    ),
    (
        "event-between-runs-fatal",
        "STATE_SNAPSHOT arrived after the run had already finished",
        "run-ended",
    ),
    (
        "explicit-content-after-chunk-fatal",
        r#"TEXT_MESSAGE_CONTENT for message "content-after-chunk-m1", which is not open"#,
        "not-open",
    ),
    (
        "first-chunk-missing-id-fatal",
        "TEXT_MESSAGE_CHUNK carries no messageId and no message is open",
        "malformed-chunk",
    ),
    (
        "first-event-not-run-started-fatal",
        "TEXT_MESSAGE_START arrived before RUN_STARTED",
        "out-of-order",
    ),
    (
        "first-tool-chunk-missing-name-fatal",
        "without a toolCallName",
        "malformed-chunk",
    ),
    ("malformed-known-field-fatal", "/delta must be string", ""),
    (
        "nested-run-started-after-closed-run-fatal",
        "RUN_STARTED arrived while a run was still active",
        "duplicate-run-started",
    ),
    (
        "nested-run-started-fatal",
        "RUN_STARTED arrived while a run was still active",
        "duplicate-run-started",
    ),
    (
        "open-message-at-run-finished-fatal",
        r#"RUN_FINISHED arrived while message "open-message-at-run-finished-m-1" was still open"#,
        "open-at-finish",
    ),
    (
        "reasoning-discipline-verified",
        r#"REASONING_MESSAGE_CONTENT for reasoning message "m-reasoning-discipline-1", which is not open"#,
        "not-open",
    ),
    (
        "reasoning-message-wrong-role-fatal",
        r#"/role must equal "reasoning""#,
        "",
    ),
    (
        "run-finished-with-active-subagent-fatal",
        r#"RUN_FINISHED arrived while subagent "s-run-finished-active-subagent-1" was still active"#,
        "open-at-finish",
    ),
    (
        "step-finished-without-start-fatal",
        r#"STEP_FINISHED for "step-finished-without-start-never-opened", which never started"#,
        "not-open",
    ),
    (
        "subagent-attribution-mismatch-fatal",
        r#"names subagent "s-subagent-attribution-mismatch-2", but the tool call was opened by subagent "s-subagent-attribution-mismatch-1""#,
        "owner-mismatch",
    ),
    (
        "subagent-finished-unstarted-fatal",
        r#"SUBAGENT_FINISHED for subagent "s-subagent-finished-unstarted-1", which is not active"#,
        "not-open",
    ),
    (
        "subagent-started-missing-name-fatal",
        "is missing required field name",
        "",
    ),
    (
        "unknown-outcome-array-fatal",
        "/outcome does not match a known union member",
        "",
    ),
];

/// The same, for the `warnings` the corpus quotes: `(stream, upstream's
/// words, this SDK's)`.
const WARNINGS: &[(&str, &str, &str)] = &[
    (
        "producer-declares-uninterpretable-version-warns",
        "cannot interpret",
        r#"uninterpretable protocol version "draft""#,
    ),
    (
        "state-delta-unappliable-warns-and-keeps",
        "Failed to apply state patch",
        "state patch failed",
    ),
];

/// The stream's `expect` as this lane reads it.
fn declared(stream: &Stream, lane: Lane) -> Value {
    let mut expect = stream.doc["expect"].clone();
    let object = expect.as_object_mut().expect("expect is an object");
    // The expanding lane's override is written for a lane that sees expanded
    // events, which is this one.
    if lane == Lane::Pipeline {
        if let Some(Value::Object(overrides)) = stream.doc.pointer("/expectOverrides/typescript") {
            for (key, value) in overrides {
                if key != "intentional" {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    if let Some((_, client, rule)) = REJECTIONS.iter().find(|row| row.0 == stream.name) {
        let words = if lane == Lane::Producer { rule } else { client };
        object.insert("errorContains".to_owned(), json!(words));
    }
    if let Some(Value::Array(warnings)) = object.get_mut("warnings") {
        for (_, upstream, here) in WARNINGS.iter().filter(|row| row.0 == stream.name) {
            let quoted = warnings.iter_mut().find(|words| words == upstream);
            *quoted.unwrap_or_else(|| panic!("{}: `{upstream}` is not declared", stream.name)) =
                json!(here);
        }
    }
    expect
}

// ---- pins ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Category {
    /// Differs on purpose, by a decision this repository already made.
    Divergence,
}

/// A lane that does not produce the declared outcome, and what it does.
struct Pin {
    stream: &'static str,
    lane: Lane,
    category: Category,
    /// The issue that resolves it.
    issue: u32,
    reason: &'static str,
    /// Exactly what the lane does today, in the corpus's vocabulary plus
    /// `end`, `diagnostics` and `at`.
    expect: Value,
}

fn pins() -> Vec<Pin> {
    use Category::Divergence;
    use Lane::{Pipeline, Thread};
    let pin = |stream, lane, category, issue, reason, expect| Pin {
        stream,
        lane,
        category,
        issue,
        reason,
        expect,
    };
    let no_peer_version = "no peer-version setting, so no version-selected downgrade (1.0: MAY)";
    let delegated = json!({
        "outcome": "completed",
        "eventTypes": [
            "RUN_STARTED", "SUBAGENT_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END", "SUBAGENT_FINISHED", "RUN_FINISHED",
        ],
        "messages": [{"role": "assistant", "content": "Found it.", "subagentRunId": "era57-s1"}],
    });
    let quiet = |mut expect: Value| {
        expect["noWarnings"] = json!(true);
        expect
    };

    vec![
        // ---- #68: version-selected downgrades ------------------------------
        // `client.maxProtocolVersion` reaches this SDK only as "omit
        // protocolVersion"; docs/migration-0.5.md, "AG-UI 1.0 wire behavior".
        pin(
            "era-0-0-39-flattens-content",
            Pipeline,
            Divergence,
            68,
            no_peer_version,
            json!({
                "outcome": "completed",
                "noWarnings": true,
                "messages": [{"id": "era39-m1", "content": "A cat."}],
            }),
        ),
        pin(
            "era-0-0-39-flattens-content",
            Thread,
            Divergence,
            68,
            no_peer_version,
            json!({
                "outcome": "completed",
                "noWarnings": true,
                "request": {"messages": [{
                    "id": "era39-u1",
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is in this picture?"},
                        {"type": "image", "source": {
                            "type": "url",
                            "value": "https://example.com/cat.png",
                            "mimeType": "image/png",
                        }},
                    ],
                }]},
                "requestAbsentPaths": ["protocolVersion"],
            }),
        ),
        pin(
            "era-0-0-57-subagent-dropped-with-warning",
            Pipeline,
            Divergence,
            68,
            no_peer_version,
            quiet(delegated.clone()),
        ),
        pin(
            "era-0-0-57-subagent-dropped-with-warning",
            Thread,
            Divergence,
            68,
            no_peer_version,
            quiet(delegated),
        ),
    ]
}

// ---- the table ----------------------------------------------------------

#[tokio::test]
async fn every_stream_produces_the_outcome_it_declares() {
    let corpus = corpus();
    let pins = pins();
    let mut failures = Vec::new();
    let mut table = Vec::new();
    let mut tally: BTreeMap<&str, usize> = BTreeMap::new();

    let declared_failed: BTreeSet<&str> = corpus
        .iter()
        .filter(|stream| stream.doc["expect"]["outcome"] == "failed")
        .map(|stream| stream.name.as_str())
        .collect();
    let worded: BTreeSet<&str> = REJECTIONS.iter().map(|row| row.0).collect();
    assert_eq!(
        worded, declared_failed,
        "REJECTIONS must have one row per stream the corpus declares failed"
    );
    for pin in &pins {
        assert!(
            corpus.iter().any(|stream| stream.name == pin.stream),
            "a pin names {}, which is not in the corpus",
            pin.stream
        );
    }

    for stream in &corpus {
        let mut cells = Vec::new();
        let mut category = "pass";
        let disagreements = failures.len();
        for lane in Lane::ALL {
            let seen = match lane {
                Lane::Pipeline => pipeline(stream).await,
                Lane::Thread => thread(stream).await,
                Lane::Producer => match producer(stream) {
                    Ok(seen) => seen,
                    Err(why) => {
                        cells.push(format!("n/a ({why})"));
                        continue;
                    }
                },
            };
            let verdict = match (&seen.rejected, &seen.run_error) {
                (Some(_), _) => "failed",
                (None, Some(_)) => "completed, RUN_ERROR",
                (None, None) => "completed",
            };
            let declared = declared(stream, lane);
            let against_declared = mismatches(&declared, &seen, false);
            let pin = pins
                .iter()
                .find(|pin| pin.stream == stream.name && pin.lane == lane);
            match pin {
                None => {
                    cells.push(verdict.to_owned());
                    for mismatch in against_declared {
                        failures.push(format!("{} [{}] {mismatch}", stream.name, lane.name()));
                    }
                }
                Some(pin) => {
                    category = match pin.category {
                        Category::Divergence => "expected divergence",
                    };
                    cells.push(format!("{verdict} [#{}: {}]", pin.issue, pin.reason));
                    if against_declared.is_empty() {
                        failures.push(format!(
                            "{} [{}] now produces the declared outcome: delete its pin",
                            stream.name,
                            lane.name()
                        ));
                    }
                    for mismatch in mismatches(&pin.expect, &seen, true) {
                        failures.push(format!(
                            "{} [{}] pinned behaviour changed: {mismatch}",
                            stream.name,
                            lane.name()
                        ));
                    }
                }
            }
        }
        if failures.len() > disagreements {
            category = "FAIL";
        }
        *tally.entry(category).or_default() += 1;
        table.push(format!(
            "{}{} | {} | {} | {} | {} | {category}",
            stream.name,
            if stream.local { " (local)" } else { "" },
            stream.doc["expect"]["outcome"].as_str().unwrap_or("?"),
            cells[0],
            cells[1],
            cells[2],
        ));
    }

    println!("\n=== AG-UI 1.0 conformance streams (spec/1.0) ===");
    println!("stream | declared | pipeline | thread | producer | category");
    for row in &table {
        println!("{row}");
    }
    println!("{} streams: {tally:?}", corpus.len());

    assert!(
        failures.is_empty(),
        "{} disagreement(s) with the corpus:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// `EventType` names every type a stream in the corpus is expected to
/// deliver, so a renamed wire tag cannot pass by matching nothing.
#[test]
fn every_declared_event_type_is_one_the_sdk_names() {
    for stream in corpus() {
        for key in ["eventTypes", "eventTypesAbsent"] {
            let Some(listed) = stream.doc["expect"].get(key) else {
                continue;
            };
            for name in strings(listed) {
                let known = serde_json::from_value::<EventType>(json!(name)).is_ok();
                // The one type the corpus lists that no version defines.
                assert!(
                    known || name == "FUTURE_EVENT",
                    "{}: {key} names {name}, which is not an event type",
                    stream.name
                );
            }
        }
    }
}
