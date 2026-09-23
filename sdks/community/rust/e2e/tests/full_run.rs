//! One complete run, over the wire, asserted from the client's side.
//!
//! The agent emits every family that has an emitter — reasoning, a tool call
//! with its result, streamed assistant text, a state publish — all inside a
//! step. The assertions are on what `ag-ui-client` assembled after the bytes
//! came back off a socket, so a fault anywhere in SSE framing, event decoding
//! or delta application lands here.

mod common;

use ag_ui::client::transport::HttpTransport;
use ag_ui::client::{RunEnd, Thread, Update};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{AssistantMessage, FunctionCall, Message, RunOutcome, ToolCall, ToolMessage};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// The state the agent publishes and the client mirrors.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Weather {
    city: String,
    temp_c: i32,
    checked: bool,
}

/// What `get_weather` is called with — parsed back out of the arguments the
/// agent itself streamed.
#[derive(Deserialize)]
struct Query {
    city: String,
}

const THOUGHT: &str = "The user named a city, so the weather tool is the one to call.";
const REPLY: &str = "It is 21\u{b0}C in Seoul.";

/// Thinks, calls a tool, answers, and publishes what it learned.
struct Forecaster;

impl Agent for Forecaster {
    type State = Weather;

    async fn run(&self, ctx: &mut RunContext<Weather>) -> Result<RunOutcome> {
        let mut step = ctx.step("forecast")?;

        step.think(THOUGHT)?;

        let mut call = step.tool_call("get_weather")?;
        // Split the way a provider streams them: neither half is valid JSON.
        call.args(r#"{"city":"#)?;
        call.args(r#""Seoul"}"#)?;
        let query: Query = call.parse_args()?;
        call.result(r#"{"tempC":21}"#)?;

        let mut message = step.assistant_message()?;
        message.delta("It is 21\u{b0}C in ")?;
        message.delta(format!("{}.", query.city))?;
        message.end()?;

        step.update_state(|weather| {
            weather.city = "Seoul".to_owned();
            weather.temp_c = 21;
            weather.checked = true;
        })?;

        drop(step);
        Ok(RunOutcome::Success)
    }
}

/// One turn against a freshly served [`Forecaster`]: the thread it left
/// behind, and every update a view would have redrawn on.
async fn run_once() -> (Thread<HttpTransport, Weather>, Vec<Update<Weather>>) {
    let url = serve(Forecaster).await;
    let mut thread = Thread::<_, Weather>::builder(transport(&url), "weather")
        .state(serde_json::json!(Weather::default()))
        .build()
        .expect("typed thread");
    thread.set_next_run_id("weather-run-1");

    let mut updates = Vec::new();
    {
        let mut run = thread
            .send_message(Message::user(
                "weather-msg-1",
                "what is the weather in Seoul?",
            ))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            // Asserted here rather than per test: an error anywhere in this
            // stream invalidates every claim made about it below, and a test
            // that only reads the updates it cares about would not see it.
            if let Update::Error(error) = &update {
                panic!("a well-formed run produced {error}");
            }
            updates.push(update);
        }
    }
    (thread, updates)
}

/// How the run ended, from the last update.
fn ending(updates: &[Update<Weather>]) -> &RunEnd {
    match updates.last() {
        Some(Update::Done(end)) => end,
        other => panic!("a run must end with Update::Done, not {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_run_round_trips_into_the_conversation_the_agent_meant_to_have() {
    let (thread, updates) = run_once().await;
    assert_eq!(ending(&updates), &RunEnd::Success { result: None });

    // Ids are derived from the thread and run ids, so the whole transcript is
    // predictable — which is what lets this be an equality assertion rather
    // than a handful of `contains`.
    let run = "weather-run-1";
    let expected = vec![
        Message::user("weather-msg-1", "what is the weather in Seoul?"),
        Message::Assistant(AssistantMessage {
            id: format!("{run}-call-1-message").into(),
            content: None,
            tool_calls: Some(vec![ToolCall {
                id: format!("{run}-call-1").into(),
                function: FunctionCall {
                    name: "get_weather".to_owned(),
                    arguments: r#"{"city":"Seoul"}"#.to_owned(),
                },
                ..Default::default()
            }]),
            ..Default::default()
        }),
        Message::Tool(ToolMessage {
            id: format!("{run}-msg-2").into(),
            content: r#"{"tempC":21}"#.to_owned().into(),
            tool_call_id: format!("{run}-call-1").into(),
            ..Default::default()
        }),
        Message::assistant(format!("{run}-msg-3"), REPLY),
    ];

    assert_eq!(thread.messages(), expected.as_slice());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_state_the_client_ends_with_is_the_state_the_agent_published() {
    let (thread, updates) = run_once().await;

    let published = Weather {
        city: "Seoul".to_owned(),
        temp_c: 21,
        checked: true,
    };
    assert_eq!(thread.state().ok(), Some(&published));
    assert_eq!(
        thread.raw_state(),
        &json!({"city": "Seoul", "tempC": 21, "checked": true}),
        "the typed view and the raw document must agree"
    );

    let states: Vec<&Weather> = updates
        .iter()
        .filter_map(|update| match update {
            Update::State(state) => Some(state),
            _ => None,
        })
        .collect();
    assert_eq!(states, [&published], "one publish, one Update::State");
}

#[tokio::test(flavor = "multi_thread")]
async fn reasoning_stays_out_of_the_transcript() {
    let (thread, updates) = run_once().await;

    let reasoning = thread.reasoning();
    assert_eq!(reasoning.len(), 1, "{reasoning:?}");
    assert_eq!(reasoning[0].id.as_str(), "weather-run-1-msg-1");
    assert_eq!(reasoning[0].content, THOUGHT);

    for message in thread.messages() {
        assert!(
            !format!("{message:?}").contains(THOUGHT),
            "reasoning leaked into the transcript: {message:?}"
        );
    }

    // A view hears about it separately, and hears the whole of it.
    let text: Vec<&str> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Reasoning(update) => Some(update.text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text.last(), Some(&THOUGHT), "{text:?}");
}

/// The order a UI redraws in: nothing arrives before the thing it describes,
/// no run produces an error update, and `Done` is last.
#[tokio::test(flavor = "multi_thread")]
async fn updates_arrive_in_the_order_the_agent_emitted_them() {
    let (_thread, updates) = run_once().await;

    let kinds: Vec<&str> = updates
        .iter()
        .map(|update| match update {
            Update::Message(_) => "message",
            Update::Messages(_) => "messages",
            Update::State(_) => "state",
            Update::Reasoning(_) => "reasoning",
            Update::Interrupt(_) => "interrupt",
            Update::Error(error) => panic!("a well-formed run produced {error}"),
            Update::Done(_) => "done",
            _ => "unrecognised",
        })
        .collect();

    // Collapsed, because how many updates one message costs is the applier's
    // business; the claim here is about the phases and their order.
    let mut phases: Vec<&str> = Vec::new();
    for kind in &kinds {
        if phases.last() != Some(kind) {
            phases.push(kind);
        }
    }
    assert_eq!(
        phases,
        ["reasoning", "message", "state", "done"],
        "{kinds:?}"
    );
}
