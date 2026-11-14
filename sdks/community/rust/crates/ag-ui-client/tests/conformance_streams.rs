//! The complete 1.0 consumer corpus. Raw fixture events deliberately bypass
//! producer validation. Producer correctness is tested in ag-ui-encoder.
#[path = "support/http.rs"]
mod http;
#[path = "conformance_support/oracle.rs"]
mod oracle;

use ag_ui_client::agent::{AgentError, AgentStateMutation};
use ag_ui_client::core::{event::Event, processing::Diagnostic, types::RunAgentInput};
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_client::{Agent, HttpAgent};
use http::TEST_TIMEOUT;
use oracle::Observation;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

#[derive(Clone, Default)]
struct Capture {
    observed: Arc<Mutex<Observation>>,
    finalized: Arc<Mutex<usize>>,
}

fn warning(diagnostic: &Diagnostic) -> String {
    format!(
        "{:?} {}: {}",
        diagnostic.category, diagnostic.path, diagnostic.message
    )
}

#[async_trait::async_trait]
impl AgentSubscriber for Capture {
    async fn on_event(
        &self,
        event: &Event,
        _params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        self.observed
            .lock()
            .unwrap()
            .events
            .push(serde_json::to_value(event).unwrap());
        Ok(Default::default())
    }

    async fn on_diagnostic(
        &self,
        diagnostic: &Diagnostic,
        _params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.observed
            .lock()
            .unwrap()
            .warnings
            .push(warning(diagnostic));
        Ok(())
    }

    async fn on_run_finalized(
        &self,
        params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        let mut observation = self.observed.lock().unwrap();
        observation.messages = params
            .messages
            .iter()
            .map(|message| serde_json::to_value(message).unwrap())
            .collect();
        observation.state = params.state.clone();
        *self.finalized.lock().unwrap() += 1;
        Ok(Default::default())
    }
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/conformance/streams")
}

fn fixture_input(fixture: &Value) -> RunAgentInput {
    // Historical positive fixtures predate request identity assertions. Seed
    // their thread and final requested run from their announced segments, but
    // do not rewrite any response event. Identity-negative tests elsewhere use
    // independent, explicitly authored input IDs and do not use this fallback.
    let last_start = fixture["stream"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|event| event["type"] == "RUN_STARTED");
    let mut raw = json!({
        "threadId": last_start.and_then(|event| event.get("threadId")).cloned().unwrap_or(json!("fixture-error-only-thread")),
        "runId": last_start.and_then(|event| event.get("runId")).cloned().unwrap_or(json!("fixture-error-only-run")),
        "messages": [],
        "state": {}
    });
    if let Some(input) = fixture.get("input") {
        for (key, value) in input.as_object().expect("fixture input object") {
            assert!(
                [
                    "threadId",
                    "runId",
                    "messages",
                    "state",
                    "tools",
                    "context",
                    "forwardedProps",
                    "protocolVersion",
                    "parentRunId",
                    "resume"
                ]
                .contains(&key.as_str()),
                "unsupported fixture input key {key}"
            );
            raw[key] = value.clone();
        }
    }
    // Raw legacy attachments are upgraded before entering the 1.0-only typed
    // message union. The same public helper is used by raw request preparation.
    ag_ui_client::core::compatibility::upgrade_outgoing_messages(&mut raw, "");
    serde_json::from_value(raw).expect("fixture input must be represented faithfully")
}

async fn replay(fixture: &Value) -> Observation {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let frames: String = fixture["stream"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    let server = tokio::spawn(async move {
        tokio::time::timeout(TEST_TIMEOUT, async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = http::read(&mut socket).await.expect("complete actual HTTP request");
            let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", frames.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            // Early consumer rejection can close the connection before all
            // deliberately invalid input is sent. The captured request remains.
            let _ = socket.write_all(frames.as_bytes()).await;
            request
        }).await.expect("fixture server timed out")
    });
    let capture = Capture::default();
    let diagnostics = capture.observed.clone();
    let agent = HttpAgent::builder()
        .with_url_str(&format!("http://{address}/"))
        .unwrap()
        .with_diagnostic_handler(move |diagnostic: &Diagnostic| {
            diagnostics
                .lock()
                .unwrap()
                .warnings
                .push(warning(diagnostic))
        })
        .build()
        .unwrap();
    let input = fixture_input(fixture);
    let result = tokio::time::timeout(TEST_TIMEOUT, agent.run_input(&input, (capture.clone(),)))
        .await
        .expect("fixture client timed out");
    let request = tokio::time::timeout(TEST_TIMEOUT, server)
        .await
        .expect("fixture server join timed out")
        .expect("fixture server failed");
    let mut observation = capture.observed.lock().unwrap().clone();
    assert_eq!(
        *capture.finalized.lock().unwrap(),
        1,
        "public lifecycle must finalize exactly once"
    );
    match result {
        Ok(result) => {
            // Public full history must agree with actual finalization state.
            let messages: Vec<_> = result
                .messages
                .iter()
                .map(|message| serde_json::to_value(message).unwrap())
                .collect();
            assert_eq!(messages, observation.messages);
            assert_eq!(result.new_state, observation.state);
        }
        Err(error) => observation.error = Some(error.to_string()),
    }
    observation.request = serde_json::from_slice(&request.body).unwrap();
    observation.request_headers = request.headers;
    observation.request_bytes = request.body;
    assert_eq!(
        observation
            .request_headers
            .get("accept")
            .map(String::as_str),
        Some("text/event-stream")
    );
    assert_eq!(
        observation
            .request_headers
            .get("content-type")
            .map(String::as_str),
        Some("application/json")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&observation.request_bytes).unwrap(),
        observation.request
    );
    observation
}

fn validate_fixture(fixture: &Value) {
    let keys = [
        "name",
        "area",
        "description",
        "specPage",
        "kill",
        "client",
        "input",
        "stream",
        "expect",
        "expectOverrides",
    ];
    for key in fixture.as_object().expect("fixture object").keys() {
        assert!(keys.contains(&key.as_str()), "unknown fixture key {key}");
    }
    for key in ["name", "area", "description", "specPage", "kill"] {
        assert!(
            fixture[key].as_str().is_some_and(|s| !s.is_empty()),
            "missing fixture {key}"
        );
    }
    assert!(
        fixture["stream"]
            .as_array()
            .is_some_and(|events| !events.is_empty())
    );
    oracle::validate_expectation(&fixture["expect"]).unwrap();
    if let Some(client) = fixture.get("client") {
        for key in client.as_object().expect("client object").keys() {
            assert_eq!(key, "maxProtocolVersion", "unknown client configuration");
        }
        assert!(client["maxProtocolVersion"].is_string());
    }
    if let Some(overrides) = fixture.get("expectOverrides") {
        for (lane, patch) in overrides.as_object().expect("overrides object") {
            assert!(
                ["rust", "typescript", "dotnet"].contains(&lane.as_str()),
                "unknown lane {lane}"
            );
            assert!(patch["intentional"].as_str().is_some_and(|s| !s.is_empty()));
            let mut resolved = fixture["expect"].clone();
            for (key, value) in patch.as_object().expect("override object") {
                if key != "intentional" {
                    resolved[key] = value.clone();
                }
            }
            // Rust can observe all keys, including ones .NET cannot. Shape and
            // unknown-key checks still apply to every lane's metadata.
            oracle::validate_expectation(&resolved).unwrap();
        }
    }
}

fn resolved_expectation(fixture: &Value) -> Value {
    let mut expected = fixture["expect"].clone();
    if let Some(overrides) = fixture.pointer("/expectOverrides/rust") {
        assert!(
            overrides["intentional"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        for (key, value) in overrides.as_object().unwrap() {
            if key != "intentional" {
                expected[key] = value.clone();
            }
        }
    }
    expected
}

#[tokio::test]
async fn manifest_streams_replay_through_http_agent() {
    let directory = fixture_dir();
    let manifest = std::fs::read_to_string(directory.join("MANIFEST.txt")).unwrap();
    let names: Vec<String> = manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect();
    let found: BTreeSet<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    oracle::manifest_matches(&names, &found).unwrap();
    assert!(!names.is_empty(), "empty conformance corpus");
    let inventory_count = names.len();
    let classifications: Vec<Value> =
        serde_json::from_str(include_str!("conformance_support/classification.json")).unwrap();
    let mut matrix = BTreeMap::new();
    for entry in classifications {
        let name = entry["file"].as_str().unwrap().to_string();
        assert!(
            matrix.insert(name, entry).is_none(),
            "duplicate classification"
        );
    }
    assert!(
        matrix.keys().all(|name| found.contains(name)),
        "stale classification"
    );
    let mut failures = Vec::new();
    let mut normative = 0;
    let mut divergent = 0;
    let mut excluded = 0;
    let mut executed = 0;
    for name in names {
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(directory.join(&name)).unwrap()).unwrap();
        assert_eq!(fixture["name"], name.trim_end_matches(".json"));
        validate_fixture(&fixture);
        let default_classification = json!({
            "classification": "normative",
            "specPage": fixture["specPage"],
            "reason": "Shared corpus expectation applies by default"
        });
        let classification = matrix.get(&name).unwrap_or(&default_classification);
        assert_eq!(classification["specPage"], fixture["specPage"]);
        assert!(
            classification["reason"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        let expected = resolved_expectation(&fixture);
        oracle::validate_expectation(&expected).unwrap_or_else(|error| panic!("{name}: {error}"));
        if classification["classification"] == "out_of_scope" {
            let old_peer = fixture
                .pointer("/client/maxProtocolVersion")
                .and_then(Value::as_str)
                .is_some_and(|version| version.starts_with("0.0."));
            let retired_binary = fixture
                .pointer("/input/messages/1/content/0/type")
                .and_then(Value::as_str)
                == Some("binary");
            assert!(
                old_peer || retired_binary,
                "{name}: stale legacy scope exclusion"
            );
            excluded += 1;
            println!(
                "OUT OF SCOPE {name}: {} ({})",
                classification["reason"], classification["specPage"]
            );
            continue;
        }
        // These two cases exercise always-on shape translation, not a peer
        // downgrade. Their legacy ceiling does not affect their expected wire.
        assert!(
            fixture.get("client").is_none()
                || matches!(
                    name.as_str(),
                    "era-0-0-45-thinking-translated.json"
                        | "era-0-0-47-upgrades-binary-content.json"
                ),
            "{name}: applicable client configuration must be implemented, never silently ignored"
        );
        executed += 1;
        let observation = replay(&fixture).await;
        match oracle::check(&observation, &expected) {
            Ok(()) => {
                match classification["classification"].as_str().unwrap() {
                    "normative" => normative += 1,
                    "normative_override" => divergent += 1,
                    other => panic!("unknown classification {other}"),
                }
                println!("PASS {name} [{}]", classification["classification"]);
            }
            Err(error) => {
                println!("FAIL {name}: {error}");
                failures.push(format!("{name}: {error}"));
            }
        }
    }
    println!(
        "{inventory_count} inventoried; {executed} executed; {normative} normative passes; {divergent} normative passes intentionally divergent from reference; {excluded} out of scope; {} failed",
        failures.len()
    );
    assert_eq!(executed + excluded, inventory_count);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn fixture_input_preserves_every_field_and_explicit_identity() {
    let fixture = json!({"stream":[{"type":"RUN_STARTED","threadId":"wrong-thread","runId":"wrong-run"}],"input":{
        "threadId":"authored-thread","runId":"authored-run","parentRunId":"parent","messages":[],"state":[1,null],
        "context":[{"description":"locale","value":"en"}],"tools":[{"name":"tool","description":"tool description","parameters":{}}],
        "forwardedProps":{"nested":null},"protocolVersion":"1.0","resume":[{"interruptId":"approval","status":"resolved","payload":false}]
    }});
    let actual = serde_json::to_value(fixture_input(&fixture)).unwrap();
    oracle::subset(&actual, &fixture["input"], "input").unwrap();
}
