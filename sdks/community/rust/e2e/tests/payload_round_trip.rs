//! What the client sends is what the agent receives, and back again.
//!
//! The other files here assert on *behaviour*; this one asserts on the payloads
//! themselves, in both directions. The request the client built has to arrive
//! field for field, a `MESSAGES_SNAPSHOT` has to carry every message variant the
//! protocol has without losing a field on the way, and state published in one
//! run has to be the state the next run starts from — as does the conversation,
//! including the turns the client did not receive whole but assembled out of
//! deltas.

mod common;

use ag_ui::axum::AgentEndpoint;
use ag_ui::client::{RemoteAgent, Thread, Update};
use ag_ui::server::{Agent, Error, Result, RunContext};
use ag_ui::{
    ActivityMessage, AssistantMessage, Context, Event, InputContent, InputContentSource,
    MediaInputContent, Message, PatchOperation, RunAgentInput, RunOutcome, TextInputContent, Tool,
    ToolCall, ToolMessage, UserContent, UserMessage,
};
use common::{serve, serve_endpoint, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

// ---------------------------------------------------------------- request ----

/// Does nothing but let the endpoint echo the request back.
struct Quiet;

impl Agent for Quiet {
    type State = ();

    async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        Ok(RunOutcome::Success)
    }
}

/// A request with every field populated, including the awkward ones.
fn request() -> RunAgentInput {
    RunAgentInput {
        thread_id: "thread-1".into(),
        run_id: "run-1".into(),
        protocol_version: Some("1.0".into()),
        parent_run_id: Some("parent-run".into()),
        state: json!({"cart": {"items": 2}, "flags": ["a", "b"]}),
        messages: conversation(),
        tools: vec![Tool::new(
            "get_weather",
            "Looks up the weather.",
            json!({"type": "object", "properties": {"city": {"type": "string"}}}),
        )],
        context: vec![Context::new("current page", "/checkout")],
        forwarded_props: json!({"tenant": "acme", "locale": "ko-KR"}),
        resume: None,
    }
}

/// One message of every variant the protocol defines, with the optional fields
/// set — anything dropped in serialization shows up as an inequality.
fn conversation() -> Vec<Message> {
    vec![
        Message::system("m-1", "You are terse."),
        Message::developer("m-2", "Debug mode is on."),
        Message::User(UserMessage {
            id: "m-3".into(),
            content: UserContent::Parts(vec![
                InputContent::Text(TextInputContent {
                    text: "what is this?".to_owned(),
                    ..Default::default()
                }),
                InputContent::Image(MediaInputContent {
                    id: None,
                    source: InputContentSource::Url {
                        value: "https://example.invalid/cat.png".to_owned(),
                        mime_type: Some("image/png".to_owned()),
                    },
                    metadata: Some(json!({"width": 640})),
                }),
            ]),
            name: Some("ada".to_owned()),
            encrypted_value: Some("opaque".to_owned()),
            ..Default::default()
        }),
        Message::Assistant(AssistantMessage {
            id: "m-4".into(),
            content: Some("Looking it up.".to_owned()),
            name: Some("assistant".to_owned()),
            encrypted_value: Some("blob".to_owned()),
            tool_calls: Some(vec![ToolCall::new(
                "call-1",
                "get_weather",
                r#"{"city":"Seoul"}"#,
            )]),
            ..Default::default()
        }),
        Message::Tool(ToolMessage {
            id: "m-5".into(),
            content: r#"{"tempC":21}"#.to_owned().into(),
            tool_call_id: "call-1".into(),
            error: Some("partial".to_owned()),
            encrypted_value: None,
            ..Default::default()
        }),
        Message::Activity(ActivityMessage {
            id: "m-6".into(),
            activity_type: "web_search".to_owned(),
            content: json!({"query": "weather seoul", "hits": 3})
                .as_object()
                .expect("an object")
                .clone(),
            ..Default::default()
        }),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn the_request_the_client_sent_is_the_request_the_agent_received() {
    let url = serve_endpoint(AgentEndpoint::new(Quiet).echo_input(true)).await;
    let client = RemoteAgent::new(transport(&url));

    let sent = request();
    let mut events = client.run_events(sent.clone());
    let first = events
        .next()
        .await
        .expect("a run starts")
        .expect("the stream should not break");

    let Event::RunStarted(started) = first else {
        panic!("the first event must be RUN_STARTED: {first:?}");
    };
    assert_eq!(started.thread_id, sent.thread_id);
    assert_eq!(started.run_id, sent.run_id);
    assert_eq!(started.parent_run_id, sent.parent_run_id);
    assert_eq!(
        started.input.as_deref(),
        Some(&sent),
        "the request must survive the round trip field for field"
    );
}

// --------------------------------------------------------------- messages ----

/// Replaces the whole conversation with one of every message variant.
struct Historian;

impl Agent for Historian {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::messages_snapshot(conversation()))?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_messages_snapshot_replaces_the_conversation_without_losing_a_field() {
    let url = serve(Historian).await;
    let mut thread = Thread::<_>::new(transport(&url), "history");

    let mut replaced = None;
    {
        let mut run = thread.send("start over").expect("run preflight");
        while let Some(update) = run.next().await {
            match update {
                Update::Messages(messages) => replaced = Some(messages),
                Update::Error(error) => panic!("a snapshot should apply cleanly: {error}"),
                _ => {}
            }
        }
    }

    assert_eq!(replaced.as_deref(), Some(conversation().as_slice()));
    // The user's own turn is gone: a snapshot is a replacement, not a merge.
    assert_eq!(thread.messages(), conversation().as_slice());
}

// ------------------------------------------------------------- activities ----

/// Reports progress as an activity, then patches it.
struct Searcher;

impl Agent for Searcher {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let content = json!({"query": "rust", "hits": 0})
            .as_object()
            .expect("an object")
            .clone();
        ctx.emit(Event::activity_snapshot("act-1", "web_search", content))?;
        ctx.emit(Event::activity_delta(
            "act-1",
            "web_search",
            vec![
                PatchOperation::replace("/hits", 12),
                PatchOperation::add("/done", true),
            ],
        ))?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_activity_is_published_and_then_patched_in_place() {
    let url = serve(Searcher).await;
    let mut thread = Thread::<_>::new(transport(&url), "search");

    {
        let mut run = thread.send("look it up").expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("an activity patch should apply cleanly: {error}");
            }
        }
    }

    assert_eq!(
        thread.messages().last(),
        Some(&Message::Activity(ActivityMessage {
            id: "act-1".into(),
            activity_type: "web_search".to_owned(),
            content: json!({"query": "rust", "hits": 12, "done": true})
                .as_object()
                .expect("an object")
                .clone(),
            ..Default::default()
        }))
    );
}

// ----------------------------------------------------------- conversation ----

/// Streams a turn on the first run and hands back whatever conversation it was
/// given on the second.
struct Recaller;

impl Agent for Recaller {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        if ctx.messages().len() > 1 {
            // The second turn. Nothing about the messages is asserted here —
            // the point is to get them back out to a test that knows what the
            // client thinks it sent.
            let received = serde_json::to_string(ctx.messages()).map_err(Error::agent)?;
            let mut call = ctx.tool_call("echo_conversation")?;
            call.args("{}")?;
            call.result(received)?;
            return Ok(RunOutcome::Success);
        }

        // The first turn, streamed in the pieces a provider sends: neither the
        // tool call's arguments nor the reply exists as a whole message
        // anywhere on the wire, so what the next request carries can only be
        // something the client assembled.
        let mut call = ctx.tool_call("get_weather")?;
        call.args(r#"{"city":"#)?;
        call.args(r#""Seoul"}"#)?;
        call.result(r#"{"tempC":21}"#)?;

        let mut message = ctx.assistant_message()?;
        message.delta("It is 21\u{b0}C ")?;
        message.delta("in Seoul.")?;
        message.end()?;

        Ok(RunOutcome::Success)
    }
}

/// The client sends its whole conversation on every run, so an agent that keeps
/// no storage of its own still gets its own last turn back — reassembled from
/// the deltas it streamed, with the ids it minted for them.
#[tokio::test(flavor = "multi_thread")]
async fn the_conversation_the_client_assembled_is_the_one_the_next_run_receives() {
    let url = serve(Recaller).await;
    let mut thread = Thread::<_>::new(transport(&url), "recall");

    {
        let mut run = thread
            .send("what is the weather in Seoul?")
            .expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("the first turn should be clean: {error}");
            }
        }
    }
    let assembled = thread.messages().to_vec();
    assert_eq!(assembled.len(), 4, "{assembled:?}");

    {
        let mut run = thread
            .send_message(Message::user("recall-msg-2", "and tomorrow?"))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("the second turn should be clean: {error}");
            }
        }
    }

    let echoed = thread
        .messages()
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Tool(tool) if tool.tool_call_id.as_str().ends_with("-call-1") => {
                tool.content.as_text().map(str::to_owned)
            }
            _ => None,
        })
        .expect("the second run should have echoed what it received");
    let received: Vec<Message> =
        serde_json::from_str(&echoed).expect("the echo should be a message list");

    // Everything the client had, in order, plus the turn it opened the second
    // run with. A message the client dropped, renamed or merged shows up here.
    assert_eq!(&received[..assembled.len()], assembled.as_slice());
    assert_eq!(
        received.get(assembled.len()),
        Some(&Message::user("recall-msg-2", "and tomorrow?")),
        "{received:?}"
    );
    assert_eq!(received.len(), assembled.len() + 1);
}

// ------------------------------------------------------------------ state ----

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Counter {
    clicks: u32,
    seen: Vec<String>,
}

/// Starts from whatever state it was handed and adds to it.
struct Accumulator;

impl Agent for Accumulator {
    type State = Counter;

    async fn run(&self, ctx: &mut RunContext<Counter>) -> Result<RunOutcome> {
        let run = ctx.run_id().to_string();
        ctx.update_state(|counter| {
            counter.clicks += 1;
            counter.seen.push(run);
        })?;
        Ok(RunOutcome::Success)
    }
}

/// The client sends its state back on the next run, so an agent that keeps no
/// storage of its own still accumulates across a conversation.
#[tokio::test(flavor = "multi_thread")]
async fn state_published_by_one_run_is_the_state_the_next_run_starts_from() {
    let url = serve(Accumulator).await;
    let mut thread = Thread::<_, Counter>::builder(transport(&url), "counter")
        .state(serde_json::json!(Counter::default()))
        .build()
        .expect("typed thread");

    for n in 1..=3 {
        thread.set_next_run_id(format!("counter-run-{n}"));
        let mut run = thread.send("again").expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("state should carry cleanly: {error}");
            }
        }
    }

    assert_eq!(
        thread.state().ok(),
        Some(&Counter {
            clicks: 3,
            seen: vec![
                "counter-run-1".to_owned(),
                "counter-run-2".to_owned(),
                "counter-run-3".to_owned(),
            ],
        })
    );
}
