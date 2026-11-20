//! The `--no-default-features` build has no HTTP client in it.
//!
//! That claim is what keeps a wasm build possible, and it is enforced in two
//! places. CI runs `cargo check -p ag-ui --no-default-features --features client` and
//! `--target wasm32-unknown-unknown`, which fails if anything outside the
//! `http` feature reaches for `reqwest`. This file guards the other half: the
//! manifest edit that would quietly make `reqwest` unconditional, which no
//! amount of compiling would catch.

#![cfg(feature = "client")]

use ag_ui::client::transport::{EventStream, Transport, TransportFuture};
use ag_ui::client::{RunEnd, Thread, Update};
use ag_ui::{Event, RunAgentInput, TextMessageRole};
use futures_util::StreamExt;

/// The crate's own manifest, read at compile time.
const MANIFEST: &str = include_str!("../Cargo.toml");

/// Every line of the manifest that mentions `reqwest`, with the section it is
/// in.
fn reqwest_lines() -> Vec<(String, String)> {
    let mut section = String::new();
    let mut found = Vec::new();
    for line in MANIFEST.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line.to_owned();
            continue;
        }
        if line.contains("reqwest") {
            found.push((section.clone(), line.to_owned()));
        }
    }
    found
}

#[test]
fn reqwest_is_optional_and_only_the_http_feature_turns_it_on() {
    let mentions = reqwest_lines();
    assert!(
        !mentions.is_empty(),
        "the http transport should still depend on reqwest"
    );

    for (section, line) in &mentions {
        match section.as_str() {
            "[dependencies]" => assert!(
                line.contains("optional = true"),
                "reqwest must stay optional, found: {line}"
            ),
            "[features]" => assert!(
                line.starts_with("http ="),
                "only the `http` feature may enable reqwest, found: {line}"
            ),
            other => panic!("reqwest must not appear in {other}: {line}"),
        }
    }

    assert!(
        mentions
            .iter()
            .any(|(section, line)| section == "[features]" && line.contains("dep:reqwest")),
        "the http feature should enable reqwest through `dep:reqwest`, so that \
         the feature and the dependency cannot drift apart"
    );
}

// The other half of the claim needs no test: without this feature there is no
// `HttpAgent` to name, and the rest of this file still compiles and runs.
#[cfg(feature = "http")]
#[test]
fn the_http_agent_builder_configures_a_transport() {
    let agent = ag_ui::client::HttpAgent::builder("https://example.com/agent")
        .header("authorization", "Bearer token")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("a valid URL and header");

    assert_eq!(
        agent.transport().url().as_str(),
        "https://example.com/agent"
    );
    assert!(agent.transport().headers().contains_key("authorization"));
    // Every request asks for the stream format, without the caller saying so.
    assert_eq!(agent.transport().headers()["accept"], "text/event-stream");
}

#[cfg(feature = "http")]
#[test]
fn a_bad_url_or_header_is_a_configuration_error_not_a_panic() {
    let error = ag_ui::client::HttpAgent::builder("not a url")
        .build()
        .expect_err("that is not a URL");
    assert!(matches!(error, ag_ui::client::Error::Config(_)));

    let error = ag_ui::client::HttpAgent::builder("https://example.com")
        .header("not a header name", "v")
        .build()
        .expect_err("that is not a header name");
    assert!(matches!(error, ag_ui::client::Error::Config(_)));
}

/// A transport with no HTTP client anywhere in it — the shape a wasm frontend
/// or an in-process agent would take.
#[derive(Clone, Debug)]
struct StaticTransport {
    events: Vec<Event>,
}

impl Transport for StaticTransport {
    fn run(&self, _input: RunAgentInput) -> TransportFuture {
        let events = self.events.clone();
        Box::pin(async move {
            let stream = futures_util::stream::iter(events.into_iter().map(Ok));
            Ok(Box::pin(stream) as EventStream)
        })
    }
}

#[tokio::test]
async fn a_custom_transport_substitutes_for_the_built_in_one() {
    let transport = StaticTransport {
        events: vec![
            Event::run_started("thread-1", "run-1"),
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            Event::text_message_content("msg-1", "From somewhere else entirely."),
            Event::text_message_end("msg-1"),
            Event::run_finished_success("thread-1", "run-1"),
        ],
    };

    let mut thread = Thread::<_>::new(transport, "thread-1");
    thread.set_next_run_id("run-1");
    let updates: Vec<_> = thread.send("hello").unwrap().collect().await;

    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));
    assert_eq!(
        thread.applier().text_of("msg-1"),
        Some("From somewhere else entirely.")
    );
}

#[tokio::test]
async fn a_boxed_transport_is_a_transport() {
    // So that a caller can choose one at runtime.
    let transport: Box<dyn Transport> = Box::new(StaticTransport {
        events: vec![
            Event::run_started("thread-1", "run-1"),
            Event::run_finished_success("thread-1", "run-1"),
        ],
    });

    let mut thread = Thread::<_>::new(transport, "thread-1");
    thread.set_next_run_id("run-1");
    let updates: Vec<_> = thread.send("hello").unwrap().collect().await;
    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));
}
