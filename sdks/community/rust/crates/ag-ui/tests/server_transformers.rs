//! Transformers, in a real run rather than in isolation.

#![cfg(feature = "server")]

#[cfg(feature = "client")]
use ag_ui::client::{apply::Applier, normalize_all};
use ag_ui::server::{
    Agent, FilterToolCalls, Result, RunContext, Runner, StreamTransformer, SubagentVisibility,
    ToolResultToState,
};
use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
#[cfg(feature = "client")]
use ag_ui::{PatchOperation, ToolCallId};
use futures_util::StreamExt as _;
use serde_json::json;

/// Calls two tools: one the client is allowed to see, one it is not.
struct TwoTools;

impl Agent for TwoTools {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        let mut public = ctx.tool_call("search")?;
        public.args(r#"{"q":"rust"}"#)?;
        public.result(r#"{"hits":1}"#)?;

        let mut private = ctx.tool_call("internal_debug")?;
        private.args(r#"{"dump":true}"#)?;
        private.result("everything")?;

        ctx.say("done")?;
        Ok(RunOutcome::Success)
    }
}

async fn collect(runner: Runner<impl Agent>) -> Vec<Event> {
    runner.run(RunAgentInput::new("t", "r")).collect().await
}

#[tokio::test]
async fn a_denied_tool_call_leaves_no_trace() {
    let events =
        collect(Runner::new(TwoTools).transformer(FilterToolCalls::deny(["internal_debug"]))).await;

    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert!(
        !format!("{events:?}").contains("internal_debug"),
        "the filtered tool should not be mentioned at all"
    );
}

#[cfg(feature = "client")]
fn tool_chunk(id: Option<&str>, name: Option<&str>, delta: &str) -> Event {
    Event::tool_call_chunk(
        id.map(ToolCallId::new),
        name.map(str::to_owned),
        Some(delta.to_owned()),
    )
}

#[cfg(feature = "client")]
struct InterleavedToolChunks;

#[cfg(feature = "client")]
impl Agent for InterleavedToolChunks {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        ctx.emit(tool_chunk(Some("public"), Some("search"), "{\"q\":\""))?;
        ctx.emit(tool_chunk(
            Some("private"),
            Some("internal_debug"),
            "{\"secret\":\"",
        ))?;
        ctx.emit(tool_chunk(None, None, "top-secret\"}"))?;
        ctx.emit(tool_chunk(Some("public"), None, "rust\"}"))?;
        ctx.emit(Event::tool_call_result("result-public", "public", "ok"))?;
        ctx.emit(Event::tool_call_result(
            "result-private",
            "private",
            "secret",
        ))?;
        Ok(RunOutcome::Success)
    }
}

#[cfg(feature = "client")]
#[tokio::test]
async fn filtered_bare_chunk_cannot_become_public_tool_arguments() {
    let events = collect(
        Runner::new(InterleavedToolChunks).transformer(FilterToolCalls::deny(["internal_debug"])),
    )
    .await;
    assert!(
        !serde_json::to_string(&events)
            .expect("serializes")
            .contains("secret"),
        "private arguments and result must stay off the wire: {events:?}"
    );

    let expanded = normalize_all(events).expect("client normalizes filtered chunks");
    let mut applier = Applier::new();
    for event in &expanded {
        applier
            .apply(event)
            .expect("client applies filtered events");
    }
    let calls: Vec<_> = applier
        .messages()
        .iter()
        .filter_map(|message| match message {
            ag_ui::Message::Assistant(assistant) => assistant.tool_calls.as_deref(),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].function.name, "search");
    assert_eq!(calls[0].function.arguments, r#"{"q":"rust"}"#);
}

#[cfg(feature = "client")]
struct ContradictoryToolChunks;

#[cfg(feature = "client")]
impl Agent for ContradictoryToolChunks {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        ctx.emit(tool_chunk(Some("public"), Some("search"), "{}"))?;
        ctx.emit(tool_chunk(None, Some("internal_debug"), "top-secret"))?;
        ctx.emit(tool_chunk(Some("public"), None, "still-secret\"}"))?;
        ctx.emit(Event::tool_call_result("result-public", "public", "ok"))?;
        Ok(RunOutcome::Success)
    }
}

#[cfg(feature = "client")]
#[tokio::test]
async fn a_denied_name_on_an_idless_chunk_cannot_borrow_an_allowed_call() {
    let wire = collect(
        Runner::new(ContradictoryToolChunks).transformer(FilterToolCalls::deny(["internal_debug"])),
    )
    .await;
    let expanded = normalize_all(wire.clone()).expect("client normalizes the visible stream");
    let mut applier = Applier::new();
    for event in &expanded {
        applier
            .apply(event)
            .expect("client applies the visible stream");
    }

    let wire_json = serde_json::to_string(&wire).expect("serializes");
    assert!(!wire_json.contains("secret"), "secret escaped: {wire_json}");
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("tool calls create assistant messages");
    };
    assert_eq!(assistant.tool_calls.as_ref().unwrap().len(), 1);
    assert_eq!(
        assistant.tool_calls.as_ref().unwrap()[0].function.arguments,
        "{}"
    );
}

#[cfg(feature = "client")]
#[test]
fn a_conflicting_name_cannot_reclassify_an_existing_call_id() {
    let mut filter = FilterToolCalls::deny(["internal_debug"]);
    let source = [
        tool_chunk(Some("one"), Some("search"), "{\"q\":\""),
        tool_chunk(Some("one"), Some("search"), "rust\"}"),
        tool_chunk(Some("one"), Some("internal_debug"), "secret-"),
        tool_chunk(Some("one"), Some("search"), "still-secret"),
        tool_chunk(None, None, "more-secret"),
    ];
    let wire: Vec<_> = source
        .into_iter()
        .flat_map(|event| filter.transform(event))
        .collect();
    let expanded = normalize_all(wire).expect("client normalizes the visible stream");
    let mut applier = Applier::new();
    for event in &expanded {
        applier
            .apply(event)
            .expect("client applies the visible stream");
    }
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("tool calls create assistant messages");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().unwrap()[0].function.arguments,
        r#"{"q":"rust"}"#
    );
}

#[cfg(feature = "client")]
#[test]
fn a_tagged_bare_chunk_cannot_change_the_parents_call_verdict() {
    let mut filter = FilterToolCalls::deny(["internal_debug"]);
    let source = [
        tool_chunk(Some("parent"), Some("search"), "{\"q\":\""),
        tool_chunk(Some("child"), Some("internal_debug"), "private").with_subagent_run_id("worker"),
        tool_chunk(None, Some("search"), "secret").with_subagent_run_id("worker"),
        tool_chunk(None, Some("search"), "rust\"}"),
    ];
    let wire: Vec<_> = source
        .into_iter()
        .flat_map(|event| filter.transform(event))
        .collect();
    let expanded = normalize_all(wire).expect("client normalizes the visible stream");
    let mut applier = Applier::new();
    for event in &expanded {
        applier
            .apply(event)
            .expect("client applies the visible stream");
    }
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("tool calls create assistant messages");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().unwrap()[0].function.arguments,
        r#"{"q":"rust"}"#
    );
}

#[cfg(feature = "client")]
#[test]
fn an_untagged_bare_chunk_follows_the_only_subagents_hidden_call() {
    let mut filter = FilterToolCalls::deny(["internal_debug"]);
    let source = [
        tool_chunk(Some("private"), Some("internal_debug"), "secret-")
            .with_subagent_run_id("child"),
        tool_chunk(None, None, "token"),
        tool_chunk(Some("public"), Some("search"), "{}"),
    ];
    let wire: Vec<_> = source
        .into_iter()
        .flat_map(|event| filter.transform(event))
        .collect();
    let expanded = normalize_all(wire).expect("client normalizes the visible call");
    let mut applier = Applier::new();
    for event in &expanded {
        applier
            .apply(event)
            .expect("client applies the visible call");
    }
    assert_eq!(applier.messages().len(), 1);
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("tool calls create assistant messages");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().unwrap()[0].function.arguments,
        "{}"
    );
}

#[cfg(feature = "client")]
struct ThreeStatePublishes;

#[cfg(feature = "client")]
impl Agent for ThreeStatePublishes {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        let notes = "a".repeat(200);
        ctx.set_state(&json!({"notes": notes, "a": 0, "b": 0}))?;
        ctx.set_state(&json!({"notes": notes, "a": 1, "b": 0}))?;
        ctx.set_state(&json!({"notes": notes, "a": 1, "b": 1}))?;
        Ok(RunOutcome::Success)
    }
}

#[cfg(feature = "client")]
struct DropSecondState(usize);

#[cfg(feature = "client")]
impl StreamTransformer for DropSecondState {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        if matches!(event, Event::StateSnapshot(_) | Event::StateDelta(_)) {
            self.0 += 1;
            if self.0 == 2 {
                return Vec::new();
            }
        }
        vec![event]
    }
}

#[cfg(feature = "client")]
#[tokio::test]
async fn a_dropped_state_event_does_not_advance_the_next_delta_baseline() {
    let events = collect(Runner::new(ThreeStatePublishes).transformer(DropSecondState(0))).await;
    let mut applier = Applier::new();
    for event in &events {
        applier
            .apply(event)
            .expect("client applies every sent event");
    }
    assert_eq!(
        applier.state(),
        &json!({"notes": "a".repeat(200), "a": 1, "b": 1})
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, Event::StateSnapshot(_) | Event::StateDelta(_)))
            .count(),
        2
    );
}

#[cfg(feature = "client")]
struct RepeatState;

#[cfg(feature = "client")]
impl Agent for RepeatState {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        let state = json!({"notes": "a".repeat(200), "step": 0});
        ctx.set_state(&state)?;
        ctx.set_state(&state)?;
        Ok(RunOutcome::Success)
    }
}

#[cfg(feature = "client")]
struct InjectStateDelta(bool);

#[cfg(feature = "client")]
impl StreamTransformer for InjectStateDelta {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        if !self.0 && matches!(event, Event::StateSnapshot(_)) {
            self.0 = true;
            return vec![
                event,
                Event::state_delta(vec![PatchOperation::replace("/step", 99)]),
            ];
        }
        vec![event]
    }
}

#[cfg(feature = "client")]
#[tokio::test]
async fn an_injected_state_delta_becomes_the_next_publish_baseline() {
    let events = collect(Runner::new(RepeatState).transformer(InjectStateDelta(false))).await;
    let mut applier = Applier::new();
    for event in &events {
        applier
            .apply(event)
            .expect("client applies every sent event");
    }
    assert_eq!(
        applier.state(),
        &json!({"notes": "a".repeat(200), "step": 0})
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, Event::StateSnapshot(_) | Event::StateDelta(_)))
            .count(),
        3,
        "the second set_state must undo the injected delta"
    );
}

#[tokio::test]
async fn a_tool_result_can_become_the_state() {
    let events = collect(
        Runner::new(TwoTools)
            .transformer(FilterToolCalls::allow(["search"]))
            .transformer(ToolResultToState::snapshot("search").replacing()),
    )
    .await;

    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::StateSnapshot,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert_eq!(events[4], Event::state_snapshot(json!({"hits": 1})));
}

#[tokio::test]
async fn a_custom_transformer_can_stamp_every_event() {
    struct Stamp(i64);

    impl StreamTransformer for Stamp {
        fn transform(&mut self, event: Event) -> Vec<Event> {
            vec![event.with_timestamp(self.0)]
        }
    }

    let events = collect(Runner::new(TwoTools).transformer(Stamp(1_700_000_000_000))).await;
    assert!(
        events
            .iter()
            .all(|event| event.base().timestamp == Some(1_700_000_000_000)),
        "every event, including the ones the driver emits, goes through the chain"
    );
}

// ---- a resumed run ----------------------------------------------------------

/// The request a resumed run answers. The interrupted run left three calls
/// unanswered: one to a public tool, one to a tool the filter denies, and
/// one made by a subagent.
fn resumed_input() -> RunAgentInput {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let mut input = RunAgentInput::new("t", "r-2");
    input.messages = vec![
        Message::user("u1", "Go on."),
        Message::Assistant(AssistantMessage {
            id: "a1".into(),
            tool_calls: Some(vec![
                ToolCall::new("c-public", "search", "{}"),
                ToolCall::new("c-private", "internal_debug", "{}"),
            ]),
            ..Default::default()
        }),
        Message::Assistant(AssistantMessage {
            id: "a2".into(),
            tool_calls: Some(vec![ToolCall::new("c-sub", "search", "{}")]),
            subagent_run_id: Some("s1".into()),
            ..Default::default()
        }),
    ];
    input
}

/// Answers every call the earlier run left open.
struct AnswersEarlierCalls;

impl Agent for AnswersEarlierCalls {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        for (message, call) in [("t1", "c-public"), ("t2", "c-private"), ("t3", "c-sub")] {
            ctx.emit(Event::tool_call_result(message, call, "done"))?;
        }
        Ok(RunOutcome::Success)
    }
}

/// The calls whose results reached the consumer, and how the run ended.
async fn answered(runner: Runner<AnswersEarlierCalls>) -> (Vec<String>, EventType) {
    let events: Vec<Event> = runner.run(resumed_input()).collect().await;
    let answered = events
        .iter()
        .filter_map(|event| match event {
            Event::ToolCallResult(result) => Some(result.tool_call_id.as_str().to_owned()),
            _ => None,
        })
        .collect();
    (
        answered,
        events.last().expect("a terminal event").event_type(),
    )
}

/// The history is the request's, not the `RUN_STARTED` echo's: a filter judges
/// a result for an earlier run's call by that call, echo or not.
#[tokio::test]
async fn the_filters_judge_an_earlier_runs_calls_the_same_with_and_without_the_echo() {
    for echo in [false, true] {
        let filtered = Runner::new(AnswersEarlierCalls)
            .echo_input(echo)
            .transformer(FilterToolCalls::deny(["internal_debug"]));
        assert_eq!(
            answered(filtered).await,
            (
                vec!["c-public".to_owned(), "c-sub".to_owned()],
                EventType::RunFinished
            ),
            "FilterToolCalls, echo {echo}"
        );

        let hidden = Runner::new(AnswersEarlierCalls)
            .echo_input(echo)
            .transformer(SubagentVisibility::hidden());
        assert_eq!(
            answered(hidden).await,
            (
                vec!["c-public".to_owned(), "c-private".to_owned()],
                EventType::RunFinished
            ),
            "SubagentVisibility::hidden, echo {echo}"
        );
    }
}

/// The earlier run's filter removed a call, so the client never held it and
/// the request does not carry it back. A resumed run that reports its result
/// is told nothing went wrong, and the result goes the way the call went.
#[tokio::test]
async fn a_result_for_a_call_an_earlier_runs_filter_removed_is_dropped_and_the_emit_is_ok() {
    use ag_ui::{AssistantMessage, Message, ToolCall};
    use std::sync::{Arc, Mutex};

    struct AnswersARemovedCall(Arc<Mutex<Vec<std::result::Result<(), String>>>>);

    impl Agent for AnswersARemovedCall {
        type State = serde_json::Value;

        async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
            let result = Event::tool_call_result("t2", "c-private", "everything");
            let outcome = ctx.emit(result).map_err(|error| error.to_string());
            self.0.lock().unwrap().push(outcome);
            Ok(RunOutcome::Success)
        }
    }

    for (list, filter) in [
        ("deny", FilterToolCalls::deny(["internal_debug"])),
        ("allow", FilterToolCalls::allow(["search"])),
    ] {
        // The conversation as the client holds it: the public call and its
        // answer, and nothing of `c-private`.
        let mut input = RunAgentInput::new("t", "r-2");
        input.messages = vec![
            Message::user("u1", "Go on."),
            Message::Assistant(AssistantMessage {
                id: "a1".into(),
                tool_calls: Some(vec![ToolCall::new("c-public", "search", "{}")]),
                ..Default::default()
            }),
            Message::tool("t1", "c-public", "1 hit"),
        ];
        let outcomes = Arc::new(Mutex::new(Vec::new()));
        let agent = AnswersARemovedCall(Arc::clone(&outcomes));
        let events: Vec<Event> = Runner::new(agent)
            .transformer(filter)
            .run(input)
            .collect()
            .await;
        let types: Vec<_> = events.iter().map(Event::event_type).collect();
        assert_eq!(
            types,
            [EventType::RunStarted, EventType::RunFinished],
            "{list}: {events:?}"
        );
        assert_eq!(*outcomes.lock().unwrap(), [Ok(())], "{list}");
    }
}

/// A transformer of your own is told the same history, once, before the run's
/// first event.
#[tokio::test]
async fn a_custom_transformer_is_seeded_with_the_history_before_the_first_event() {
    use std::sync::{Arc, Mutex};

    struct Records(Arc<Mutex<Vec<String>>>);

    impl StreamTransformer for Records {
        fn seed(&mut self, history: &[ag_ui::Message]) {
            let mut seen = self.0.lock().unwrap();
            seen.extend(
                history
                    .iter()
                    .map(|message| message.id().as_str().to_owned()),
            );
        }

        fn transform(&mut self, event: Event) -> Vec<Event> {
            if let Event::RunStarted(_) = &event {
                self.0.lock().unwrap().push("RUN_STARTED".to_owned());
            }
            vec![event]
        }
    }

    let seen = Arc::new(Mutex::new(Vec::new()));
    let runner = Runner::new(AnswersEarlierCalls).transformer(Records(Arc::clone(&seen)));
    let _ = answered(runner).await;
    assert_eq!(*seen.lock().unwrap(), ["u1", "a1", "a2", "RUN_STARTED"]);
}

// ---- subagent visibility --------------------------------------------------

/// Says something, delegates to a subagent that says something and calls a
/// tool, restates history with one attributed message, and says something
/// more.
struct Delegating;

impl Agent for Delegating {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        ctx.say("parent first")?;
        {
            let mut researcher = ctx.subagent("researcher")?;
            researcher.say("child")?;
            let mut call = researcher.tool_call("search")?;
            call.args("{}")?;
            call.result("hit")?;
            researcher.finish()?;
        }
        ctx.emit(Event::messages_snapshot(vec![
            ag_ui::Message::assistant("h1", "history"),
            ag_ui::Message::Assistant(ag_ui::AssistantMessage {
                id: "h2".into(),
                content: Some("theirs".into()),
                subagent_run_id: Some("s-old".into()),
                ..Default::default()
            }),
        ]))?;
        ctx.say("parent last")?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn attributed_is_the_default_and_the_full_surface() {
    let events = collect(Runner::new(Delegating)).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::SubagentStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::SubagentFinished,
            EventType::MessagesSnapshot,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert!(events[5..12].iter().all(|e| e.subagent_run_id().is_some()));
}

#[tokio::test]
async fn inline_visibility_flattens_the_stream_to_the_pre_subagent_shape() {
    let events = collect(Runner::new(Delegating).transformer(SubagentVisibility::inline())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::MessagesSnapshot,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert!(
        events.iter().all(|e| e.subagent_run_id().is_none()),
        "nothing on the wire says subagent"
    );
    let Event::MessagesSnapshot(snapshot) = &events[11] else {
        panic!("wrong variant");
    };
    assert_eq!(snapshot.messages.len(), 2);
    assert!(
        snapshot
            .messages
            .iter()
            .all(|m| m.subagent_run_id().is_none()),
        "the history is stripped too"
    );
    assert!(
        !serde_json::to_string(&events).unwrap().contains("subagent"),
        "not even as a substring"
    );
}

#[tokio::test]
async fn hidden_visibility_keeps_only_the_parents_events() {
    let events = collect(Runner::new(Delegating).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::MessagesSnapshot,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    let Event::MessagesSnapshot(snapshot) = &events[4] else {
        panic!("wrong variant");
    };
    assert_eq!(
        snapshot.messages.len(),
        1,
        "the attributed history message went too"
    );
}

#[test]
fn hidden_drops_an_untagged_continuation_of_a_subagents_message() {
    let mut filter = SubagentVisibility::hidden();
    assert!(
        filter
            .transform(
                Event::text_message_start("m1", Default::default()).with_subagent_run_id("s1")
            )
            .is_empty()
    );
    assert!(
        filter
            .transform(Event::text_message_content("m1", "hi"))
            .is_empty(),
        "legal on the wire, but it belongs to the subagent"
    );
    assert!(filter.transform(Event::text_message_end("m1")).is_empty());
    // The first writer owns the id for the run, as the verifier reads it: an
    // untagged re-open of m1 is still the subagent's, and a fresh id is the
    // parent's.
    assert!(
        filter
            .transform(Event::text_message_start("m1", Default::default()))
            .is_empty()
    );
    assert_eq!(
        filter
            .transform(Event::text_message_start("m2", Default::default()))
            .len(),
        1
    );
    assert_eq!(filter.mode(), SubagentVisibility::Hidden);
}

/// A subagent that moves the shared state, then says so.
struct Publishing;

impl Agent for Publishing {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        {
            let mut worker = ctx.subagent("worker")?;
            worker.set_state(&json!({"done": 1}))?;
            worker.say("moved it")?;
            worker.finish()?;
        }
        ctx.say("noted")?;
        // The parent moves it again, so a consumer that missed the first
        // publish has a second one to fail on.
        ctx.set_state(&json!({"done": 2}))?;
        Ok(RunOutcome::Success)
    }
}

/// The state is the thread's, whoever published it: a client that never saw
/// the subagent's `STATE_SNAPSHOT` would mirror a stale board and send it
/// back on its next request.
#[tokio::test]
async fn hidden_visibility_keeps_the_state_a_subagent_published() {
    let events = collect(Runner::new(Publishing).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::StateSnapshot,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            // The parent's own publish: a snapshot, being smaller than the
            // patch on a state this size.
            EventType::StateSnapshot,
            EventType::RunFinished,
        ]
    );
    assert_eq!(
        events[1].subagent_run_id(),
        None,
        "the state goes out as the parent's"
    );
    let Event::StateSnapshot(snapshot) = &events[1] else {
        unreachable!("asserted above");
    };
    assert_eq!(snapshot.snapshot, json!({"done": 1}));

    // Attributed and inline agree on the payload; only the tag differs.
    let attributed = collect(Runner::new(Publishing)).await;
    assert_eq!(
        attributed[2].subagent_run_id().map(|id| id.as_str()),
        Some("r-sub-1")
    );
    let inline = collect(Runner::new(Publishing).transformer(SubagentVisibility::inline())).await;
    assert_eq!(inline[1].event_type(), EventType::StateSnapshot);
    assert_eq!(inline[1].subagent_run_id(), None);
}

/// A subagent that pauses the run on a question of its own.
struct Pausing;

impl Agent for Pausing {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        let mut worker = ctx.subagent("worker")?;
        worker.say("May I?")?;
        let interrupt =
            ag_ui::Interrupt::new("ok", "tool_approval").with_subagent_run_id(worker.id().clone());
        worker.suspend(vec![interrupt.id.clone()])?;
        Ok(RunOutcome::interrupt(vec![interrupt]))
    }
}

/// The question still stands for a consumer that never saw the subagent, so
/// the interrupt stays and only its tag goes — with it, nothing on the wire
/// says subagent.
#[tokio::test]
async fn inline_and_hidden_strip_the_attribution_from_interrupts_too() {
    for filter in [SubagentVisibility::inline(), SubagentVisibility::hidden()] {
        let mode = filter.mode();
        let events = collect(Runner::new(Pausing).transformer(filter)).await;

        let Some(Event::RunFinished(finished)) = events.last() else {
            panic!("{mode:?}: the run must end with RUN_FINISHED: {events:?}");
        };
        let interrupts = finished.outcome.as_ref().expect("an outcome").interrupts();
        assert_eq!(interrupts.len(), 1, "{mode:?}: {events:?}");
        assert_eq!(interrupts[0].id, "ok");
        assert_eq!(interrupts[0].subagent_run_id, None, "{mode:?}");

        for event in &events {
            let json = serde_json::to_string(event).expect("serializes");
            assert!(!json.contains("subagentRunId"), "{mode:?}: {json}");
        }
    }
}

/// Hand-built streams the sink would have tagged: the filter judges an
/// untagged event by who owns the id it continues, as the verifier does.
#[test]
fn hidden_drops_untagged_continuations_of_a_subagents_entities() {
    use ag_ui::server::StreamTransformer as _;
    use ag_ui::{AssistantMessage, Message, ToolCall, ToolMessage};

    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let mut filter = SubagentVisibility::hidden();
    let mut kept = |event: Event| !filter.transform(event).is_empty();

    // A chunk stream: the first chunk names the id and the owner, the rest
    // name neither.
    assert!(!kept(tagged(
        Event::text_message_chunk(Some("m1".into()), Some("Hel".into())),
        "s1"
    )));
    assert!(!kept(Event::text_message_chunk(None, Some("lo".into()))));
    assert!(!kept(Event::text_message_chunk(
        Some("m1".into()),
        Some("!".into())
    )));
    // The parent's own chunk stream is untouched.
    assert!(kept(Event::text_message_chunk(
        Some("m2".into()),
        Some("mine".into())
    )));
    assert!(kept(Event::text_message_chunk(None, Some(" too".into()))));

    // A call carried by a subagent's message is the subagent's, tag or no tag
    // — and so is its end and its result.
    assert!(!kept(tagged(
        Event::text_message_start("m3", ag_ui::TextMessageRole::Assistant),
        "s1"
    )));
    let mut start = ag_ui::ToolCallStartEvent::new("c1", "search");
    start.parent_message_id = Some("m3".into());
    assert!(!kept(Event::ToolCallStart(start)));
    assert!(!kept(Event::tool_call_args("c1", "{}")));
    assert!(!kept(tagged(Event::tool_call_end("c1"), "s1")));
    assert!(!kept(Event::tool_call_result("m4", "c1", "hit")));
    // An untagged re-open after the close is still the subagent's.
    assert!(!kept(tagged(Event::text_message_end("m3"), "s1")));
    assert!(!kept(Event::text_message_start(
        "m3",
        ag_ui::TextMessageRole::Assistant
    )));
    assert!(!kept(Event::text_message_end("m3")));

    // A snapshot restates the conversation: the subagent's messages go, and
    // so does the tool message answering a call inside one of them.
    let mut filter = SubagentVisibility::hidden();
    let out = filter.transform(Event::messages_snapshot(vec![
        Message::assistant("h1", "mine"),
        Message::Assistant(AssistantMessage {
            id: "h2".into(),
            tool_calls: Some(vec![ToolCall::new("hc1", "search", "{}")]),
            subagent_run_id: Some("s1".into()),
            ..Default::default()
        }),
        Message::Tool(ToolMessage {
            id: "h3".into(),
            content: "hit".into(),
            tool_call_id: "hc1".into(),
            ..Default::default()
        }),
    ]));
    let Some(Event::MessagesSnapshot(snapshot)) = out.first() else {
        panic!("the snapshot is kept: {out:?}");
    };
    let ids: Vec<&str> = snapshot.messages.iter().map(|m| m.id().as_str()).collect();
    assert_eq!(ids, ["h1"]);
    // And the ids it named stay hidden afterwards.
    assert!(
        filter
            .transform(Event::tool_call_result("h4", "hc1", "again"))
            .is_empty()
    );
}

/// The round trip a consumer makes: the subagent's publish and the parent's
/// later one both apply, in hidden mode as in the others — which is the whole
/// reason the state is kept.
#[cfg(feature = "client")]
#[tokio::test]
async fn hidden_visibility_state_applies_on_the_client_including_a_later_parent_publish() {
    use ag_ui::client::Applier;

    for filter in [
        SubagentVisibility::Attributed.filter(),
        SubagentVisibility::inline(),
        SubagentVisibility::hidden(),
    ] {
        let mode = filter.mode();
        let events = collect(Runner::new(Publishing).transformer(filter)).await;
        let mut applier = Applier::new();
        for event in &events {
            applier
                .apply(event)
                .unwrap_or_else(|error| panic!("{mode:?}: {event:?} should apply: {error}"));
        }
        assert_eq!(applier.state(), &json!({"done": 2}), "{mode:?}");
    }
}

/// Agents as tools, with the result reported from inside the subagent: the
/// parent's call, answered by the child.
struct AsTool;

impl Agent for AsTool {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        let mut call = ctx.tool_call("task")?;
        call.args("{}")?;
        let (call_id, result_id) = (call.id().clone(), call.result_message_id().clone());
        call.end()?;
        {
            let announce = ag_ui::SubagentStartedEvent::new("s-1", "researcher")
                .with_parent_tool_call(call_id.clone());
            let mut researcher = ctx.subagent_with(announce)?;
            researcher.say("child")?;
            researcher.emit(Event::tool_call_result(result_id, call_id, "3 sources"))?;
            researcher.finish()?;
        }
        ctx.say("done")?;
        Ok(RunOutcome::Success)
    }
}

/// The consumer saw the parent's call, so it is owed the answer whoever
/// wrote it — a call left unanswered in the history is what the next request
/// would carry back.
#[tokio::test]
async fn hidden_keeps_the_answer_to_the_parents_call_whoever_executed_it() {
    let attributed = collect(Runner::new(AsTool)).await;
    let result = attributed
        .iter()
        .find(|event| event.event_type() == EventType::ToolCallResult)
        .expect("a result");
    assert_eq!(
        result.subagent_run_id().map(|id| id.as_str()),
        Some("s-1"),
        "the sink tagged the result with the executor"
    );

    let hidden = collect(Runner::new(AsTool).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = hidden.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert_eq!(hidden[4].subagent_run_id(), None, "as the parent's");

    // The same in a replay: a tool message answering a visible call stays,
    // untagged; one answering a hidden call goes with the call.
    use ag_ui::server::StreamTransformer as _;
    use ag_ui::{AssistantMessage, Message, ToolCall, ToolMessage};
    let mut filter = SubagentVisibility::hidden();
    let out = filter.transform(Event::messages_snapshot(vec![
        Message::Assistant(AssistantMessage {
            id: "h1".into(),
            tool_calls: Some(vec![ToolCall::new("c-parent", "task", "{}")]),
            ..Default::default()
        }),
        Message::Tool(ToolMessage {
            id: "h2".into(),
            content: "3 sources".into(),
            tool_call_id: "c-parent".into(),
            subagent_run_id: Some("s-1".into()),
            ..Default::default()
        }),
        Message::Assistant(AssistantMessage {
            id: "h3".into(),
            tool_calls: Some(vec![ToolCall::new("c-child", "search", "{}")]),
            subagent_run_id: Some("s-1".into()),
            ..Default::default()
        }),
        Message::Tool(ToolMessage {
            id: "h4".into(),
            content: "hit".into(),
            tool_call_id: "c-child".into(),
            ..Default::default()
        }),
    ]));
    let Some(Event::MessagesSnapshot(snapshot)) = out.first() else {
        panic!("the snapshot is kept: {out:?}");
    };
    let ids: Vec<&str> = snapshot.messages.iter().map(|m| m.id().as_str()).collect();
    assert_eq!(ids, ["h1", "h2"]);
    assert_eq!(snapshot.messages[1].subagent_run_id(), None);
}

/// A subagent running a step of the same name as the parent's open step —
/// legal attributed, since steps are keyed by owner.
struct SameStep;

impl Agent for SameStep {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        let mut outer = ctx.step("board")?;
        {
            let mut worker = outer.subagent("worker")?;
            let mut inner = worker.step("board")?;
            inner.say("nested")?;
            drop(inner);
            worker.finish()?;
        }
        outer.say("done")?;
        Ok(RunOutcome::Success)
    }
}

/// The flattened shape cannot express it — with the tags gone the two
/// steps would collide — so Inline drops a subagent's steps, as it drops the
/// lifecycle events, and the run finishes. Hidden drops them with the rest.
#[tokio::test]
async fn inline_drops_a_subagents_steps_rather_than_colliding_them() {
    let attributed = collect(Runner::new(SameStep)).await;
    assert_eq!(
        attributed
            .iter()
            .filter(|e| e.event_type() == EventType::StepStarted)
            .count(),
        2
    );

    for filter in [SubagentVisibility::inline(), SubagentVisibility::hidden()] {
        let mode = filter.mode();
        let events = collect(Runner::new(SameStep).transformer(filter)).await;
        let steps: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, Event::StepStarted(_) | Event::StepFinished(_)))
            .map(|e| (e.event_type(), e.subagent_run_id().is_some()))
            .collect();
        assert_eq!(
            steps,
            [
                (EventType::StepStarted, false),
                (EventType::StepFinished, false)
            ],
            "{mode:?}: {events:?}"
        );
        assert_eq!(
            events.last().map(Event::event_type),
            Some(EventType::RunFinished),
            "{mode:?}: {events:?}"
        );
    }
    // Inline still carries the nested say, as the parent's.
    let inline = collect(Runner::new(SameStep).transformer(SubagentVisibility::inline())).await;
    assert_eq!(
        inline
            .iter()
            .filter(|e| e.event_type() == EventType::TextMessageEnd)
            .count(),
        2
    );
}

/// The filter's reading of an untagged, id-less chunk is the consuming
/// normalizer's: the parent's open stream when there is one, otherwise the
/// only open stream — which is a subagent's if any is.
#[test]
fn hidden_routes_an_untagged_idless_chunk_like_the_normalizer() {
    use ag_ui::server::StreamTransformer as _;
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let chunk = |id: Option<&str>, delta: &str| {
        Event::text_message_chunk(id.map(ag_ui::MessageId::new), Some(delta.to_owned()))
    };
    let mut filter = SubagentVisibility::hidden();
    let mut kept = |event: Event| !filter.transform(event).is_empty();

    // The parent opened m1 by chunk; a subagent's chunk in between does not
    // take the parent's continuation away from it.
    assert!(kept(chunk(Some("m1"), "a")));
    assert!(!kept(tagged(chunk(Some("m2"), "x"), "s1")));
    assert!(kept(chunk(None, "b")));

    // An explicit start is not a stream a chunk can continue, and it ends
    // the parent's chunk stream: the only one left is the subagent's.
    assert!(kept(Event::text_message_start("m3", Default::default())));
    assert!(!kept(chunk(None, "c")));
    assert!(kept(Event::text_message_end("m3")));

    // The subagent opens another; it is still the only open one.
    assert!(!kept(tagged(chunk(Some("m4"), "y"), "s1")));
    assert!(!kept(chunk(None, "d")));

    // An event in the subagent's lane ends its stream. Nothing is open: the
    // chunk passes and the consumer, not the filter, is the one to complain.
    assert!(!kept(tagged(Event::custom("note", json!(1)), "s1")));
    assert!(kept(chunk(None, "e")));
}

/// The filters follow the stream by the rules a consumer expands chunks by,
/// so what ends a chunk stream for the consumer ends it here: a chunk that
/// names no id after it is not handed the id of a stream that is over.
#[test]
fn the_filters_end_a_chunk_stream_where_the_consumer_does() {
    use ag_ui::server::StreamTransformer as _;
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let chunk = |delta: &str| Event::text_message_chunk(None, Some(delta.to_owned()));
    let opening =
        || Event::text_message_chunk(Some(ag_ui::MessageId::new("m1")), Some("a".to_owned()));
    let id_of = |events: &[Event]| match events {
        [Event::TextMessageChunk(chunk)] => chunk.message_id.clone(),
        other => panic!("expected the chunk back, got {other:?}"),
    };

    for ender in [
        Event::custom("note", json!(1)),
        Event::state_snapshot(json!({})),
        Event::step_started("plan"),
        Event::reasoning_start("r1"),
        Event::messages_snapshot(Vec::<ag_ui::Message>::new()),
        Event::subagent_finished("s1"),
    ] {
        let kind = ender.event_type();
        let mut inline = SubagentVisibility::inline();
        inline.transform(tagged(opening(), "s1"));
        assert_eq!(
            id_of(&inline.transform(tagged(chunk("b"), "s1"))),
            Some("m1".into()),
            "the subagent's stream is open, so the chunk is given its id"
        );
        let ender = match ender {
            lifecycle @ Event::SubagentFinished(_) => lifecycle,
            other => tagged(other, "s1"),
        };
        inline.transform(ender);
        assert_eq!(
            id_of(&inline.transform(tagged(chunk("c"), "s1"))),
            None,
            "{kind} ended the stream, so the chunk is left for the consumer to refuse"
        );
    }

    // RAW stands aside, as it does for the consumer.
    let mut inline = SubagentVisibility::inline();
    inline.transform(tagged(opening(), "s1"));
    inline.transform(tagged(Event::raw(json!({})), "s1"));
    assert_eq!(
        id_of(&inline.transform(tagged(chunk("b"), "s1"))),
        Some("m1".into())
    );
}

/// An activity is owned by the snapshot that minted it, and only a replacing
/// snapshot re-mints it — the verifiers' rule, applied to what the consumer
/// gets to see.
#[test]
fn hidden_tracks_activities_by_their_owner() {
    use ag_ui::server::StreamTransformer as _;
    use ag_ui::{JsonObject, PatchOperation};
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let snapshot = |id: &str, replace: bool| {
        let mut event = ag_ui::ActivitySnapshotEvent::new(id, "progress", JsonObject::new());
        event.replace = replace;
        Event::ActivitySnapshot(event)
    };
    let delta =
        |id: &str| Event::activity_delta(id, "progress", vec![PatchOperation::add("/s", 1)]);
    let mut filter = SubagentVisibility::hidden();

    // A subagent's activity, and the parent's untagged patch of it, which
    // the consumer could not apply to something it never saw.
    assert!(
        filter
            .transform(tagged(snapshot("a1", true), "s1"))
            .is_empty()
    );
    assert!(filter.transform(delta("a1")).is_empty());
    assert!(
        filter.transform(snapshot("a1", false)).is_empty(),
        "a merge keeps the owner"
    );

    // A replacing snapshot from the parent re-mints it for the consumer.
    assert_eq!(filter.transform(snapshot("a1", true)).len(), 1);
    assert_eq!(filter.transform(delta("a1")).len(), 1);

    // A subagent merging into the parent's activity: the entity is visible,
    // so the change reaches the consumer, untagged.
    let out = filter.transform(tagged(snapshot("a1", false), "s1"));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].subagent_run_id(), None);
}

/// An opaque blob for an entity the consumer never saw goes with the entity.
#[test]
fn hidden_drops_an_encrypted_value_for_a_hidden_entity() {
    use ag_ui::ReasoningEncryptedValueSubtype;
    use ag_ui::server::StreamTransformer as _;
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let mut filter = SubagentVisibility::hidden();
    let mut kept = |event: Event| !filter.transform(event).is_empty();

    assert!(!kept(tagged(Event::tool_call_start("c1", "search"), "s1")));
    assert!(!kept(tagged(Event::reasoning_message_start("r1"), "s1")));
    assert!(kept(Event::tool_call_start("c2", "search")));

    let blob = |subtype, id: &str| Event::reasoning_encrypted_value(subtype, id, "opaque");
    assert!(!kept(blob(ReasoningEncryptedValueSubtype::ToolCall, "c1")));
    assert!(!kept(blob(ReasoningEncryptedValueSubtype::Message, "r1")));
    assert!(kept(blob(ReasoningEncryptedValueSubtype::ToolCall, "c2")));
    assert!(!kept(tagged(
        blob(ReasoningEncryptedValueSubtype::ToolCall, "c2"),
        "s1"
    )));
}

/// A snapshot restates what it carries and leaves the rest as the run
/// established it — the verifiers' reading of an authoritative seed.
#[test]
fn hidden_keeps_what_a_snapshot_did_not_restate() {
    use ag_ui::Message;
    use ag_ui::server::StreamTransformer as _;
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let mut filter = SubagentVisibility::hidden();
    let mut kept = |event: Event| !filter.transform(event).is_empty();

    assert!(!kept(tagged(
        Event::text_message_start("m1", Default::default()),
        "s1"
    )));
    assert!(!kept(tagged(Event::text_message_end("m1"), "s1")));

    // A snapshot that does not mention m1 does not hand it to the parent…
    assert!(kept(Event::messages_snapshot(vec![Message::user(
        "u1", "hi"
    )])));
    assert!(!kept(Event::text_message_start("m1", Default::default())));
    assert!(!kept(tagged(
        Event::text_message_content("m1", "more"),
        "s1"
    )));
    assert!(!kept(tagged(Event::text_message_end("m1"), "s1")));

    // …one that restates it as the parent's does.
    assert!(kept(Event::messages_snapshot(vec![Message::assistant(
        "m1", "mine now"
    )])));
    assert!(kept(Event::text_message_start("m1", Default::default())));
    assert!(kept(Event::text_message_end("m1")));
}

// ---- review round 3 ---------------------------------------------------------

/// Emits whatever it is given, so a hand-written stream can go through a
/// real run — and the server's own post-chain verifier.
struct Replay(Vec<Event>);

impl Agent for Replay {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        for event in &self.0 {
            ctx.emit(event.clone())?;
        }
        Ok(RunOutcome::Success)
    }
}

/// What a client makes of a stream: the texts by message id, in order.
#[cfg(feature = "client")]
fn assembled(events: Vec<Event>) -> Vec<(String, String)> {
    use ag_ui::client::{Applier, normalize_all, verify_all};
    let events = normalize_all(events).expect("normalizes");
    verify_all(&events).unwrap_or_else(|error| panic!("{error}\n{events:?}"));
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    applier
        .messages()
        .iter()
        .filter_map(|message| match message {
            ag_ui::Message::Assistant(assistant) => Some((
                message.id().as_str().to_owned(),
                assistant.content.clone().unwrap_or_default(),
            )),
            _ => None,
        })
        .collect()
}

/// A chunk that names no id is resolved through its attribution on the
/// consuming side, so Inline gives it the id it would have resolved to
/// before taking the attribution away — and the consumer assembles the same
/// messages it would have from the attributed stream.
#[cfg(feature = "client")]
#[tokio::test]
async fn inline_gives_a_bare_chunk_the_id_its_attribution_resolved_to() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let chunk = |id: Option<&str>, delta: &str| {
        Event::text_message_chunk(id.map(ag_ui::MessageId::new), Some(delta.to_owned()))
    };

    // The parent's continuation, with a subagent's chunk in between.
    let script = vec![
        chunk(Some("m0"), "p1"),
        tagged(chunk(Some("m1"), "a"), "s1"),
        chunk(None, "p2"),
        tagged(chunk(None, "b"), "s1"),
    ];
    let attributed = assembled(collect(Runner::new(Replay(script.clone()))).await);
    let inline = assembled(
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::inline())).await,
    );
    assert_eq!(
        attributed,
        [
            ("m0".to_owned(), "p1p2".to_owned()),
            ("m1".to_owned(), "ab".to_owned())
        ]
    );
    assert_eq!(inline, attributed);

    // Two subagents streaming at once, every chunk attributed as the docs ask.
    let script = vec![
        tagged(chunk(Some("m1"), "a"), "s1"),
        tagged(chunk(Some("m2"), "b"), "s2"),
        tagged(chunk(None, "c"), "s1"),
        tagged(chunk(None, "d"), "s2"),
    ];
    let attributed = assembled(collect(Runner::new(Replay(script.clone()))).await);
    let inline = assembled(
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::inline())).await,
    );
    assert_eq!(
        attributed,
        [
            ("m1".to_owned(), "ac".to_owned()),
            ("m2".to_owned(), "bd".to_owned())
        ]
    );
    assert_eq!(inline, attributed);

    // A subagent's explicit message in the middle of the parent's chunks.
    let script = vec![
        chunk(Some("m0"), "p1"),
        tagged(Event::text_message_start("m1", Default::default()), "s1"),
        tagged(Event::text_message_content("m1", "x"), "s1"),
        tagged(Event::text_message_end("m1"), "s1"),
        chunk(None, "p2"),
    ];
    let attributed = assembled(collect(Runner::new(Replay(script.clone()))).await);
    let inline = assembled(
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::inline())).await,
    );
    assert_eq!(
        attributed,
        [
            ("m0".to_owned(), "p1p2".to_owned()),
            ("m1".to_owned(), "x".to_owned())
        ]
    );
    assert_eq!(inline, attributed);
}

/// The same for a tool call streamed by chunks: the filled-in chunk carries
/// the name the consumer needs to reopen the call.
#[cfg(feature = "client")]
#[tokio::test]
async fn inline_gives_a_bare_tool_chunk_its_call_and_name() {
    use ag_ui::client::{Applier, normalize_all};
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let text = |id: Option<&str>, delta: &str| {
        Event::text_message_chunk(id.map(ag_ui::MessageId::new), Some(delta.to_owned()))
    };
    let tool = |id: Option<&str>, name: Option<&str>, delta: &str| {
        Event::tool_call_chunk(
            id.map(ag_ui::ToolCallId::new),
            name.map(str::to_owned),
            Some(delta.to_owned()),
        )
    };
    let script = vec![
        tagged(tool(Some("c1"), Some("search"), r#"{"q":"#), "s1"),
        text(Some("m0"), "p1"),
        tagged(tool(None, None, r#""rust"}"#), "s1"),
        text(None, "p2"),
    ];
    let inline =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::inline())).await;
    let events = normalize_all(inline).expect("normalizes");
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("m0"), Some("p1p2"));
    let call = applier
        .messages()
        .iter()
        .find_map(|message| match message {
            ag_ui::Message::Assistant(assistant) => assistant
                .tool_calls
                .iter()
                .flatten()
                .find(|call| call.id.as_str() == "c1")
                .cloned(),
            _ => None,
        })
        .expect("the call assembled");
    assert_eq!(call.function.name, "search");
    assert_eq!(call.function.arguments, r#"{"q":"rust"}"#);
}

/// A result the parent's call got from a subagent goes out untagged, and the
/// consumer's normalizer then closes the parent's open stream — so the
/// parent's next bare chunk carries its id and reopens the message.
#[cfg(feature = "client")]
#[tokio::test]
async fn hidden_gives_the_parents_bare_chunk_its_id_after_a_result_it_did_not_execute() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let chunk = |id: Option<&str>, delta: &str| {
        Event::text_message_chunk(id.map(ag_ui::MessageId::new), Some(delta.to_owned()))
    };
    let script = vec![
        Event::tool_call_start("c1", "task"),
        Event::tool_call_args("c1", "{}"),
        Event::tool_call_end("c1"),
        chunk(Some("m0"), "p1"),
        tagged(Event::tool_call_result("r1", "c1", "done"), "s1"),
        chunk(None, "p2"),
    ];
    let attributed = assembled(collect(Runner::new(Replay(script.clone()))).await);
    let hidden = assembled(
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await,
    );
    // The parent's call sits in a message of its own, then the text.
    assert_eq!(
        attributed,
        [
            ("c1-message".to_owned(), String::new()),
            ("m0".to_owned(), "p1p2".to_owned())
        ]
    );
    assert_eq!(hidden, attributed);
}

/// Text and reasoning ids live in separate buckets, as the verifiers keep
/// them: a subagent's reasoning under an id does not hide the parent's text
/// message under the same id.
#[tokio::test]
async fn hidden_keeps_text_and_reasoning_ids_apart() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let script = vec![
        tagged(Event::reasoning_start("x"), "s1"),
        tagged(Event::reasoning_message_start("x"), "s1"),
        tagged(Event::reasoning_message_content("x", "thinking"), "s1"),
        tagged(Event::reasoning_message_end("x"), "s1"),
        tagged(Event::reasoning_end("x"), "s1"),
        Event::text_message_start("x", Default::default()),
        Event::text_message_content("x", "hi"),
        Event::text_message_end("x"),
    ];
    let events =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ],
        "{events:?}"
    );
}

/// An entity the consumer saw opened keeps that visibility until it closes,
/// whatever a snapshot says about its owner meanwhile — in both directions.
/// Through a real run, so the server's own post-chain verifier has its say.
#[tokio::test]
async fn an_open_entity_keeps_the_visibility_it_was_opened_with() {
    use ag_ui::{AssistantMessage, Message};
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let restated = |owner: Option<&str>| {
        Event::messages_snapshot(vec![Message::Assistant(AssistantMessage {
            id: "m1".into(),
            content: Some("so far".into()),
            subagent_run_id: owner.map(Into::into),
            ..Default::default()
        })])
    };

    // The parent opened m1; a snapshot hands it to s1; the parent closes it.
    let script = vec![
        Event::text_message_start("m1", Default::default()),
        restated(Some("s1")),
        Event::text_message_content("m1", "hi"),
        Event::text_message_end("m1"),
    ];
    let events =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::MessagesSnapshot,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ],
        "{events:?}"
    );

    // s1 opened m1; a snapshot hands it to the parent; s1 closes it. The
    // consumer never saw it open, so it does not see it close either.
    let script = vec![
        tagged(Event::text_message_start("m1", Default::default()), "s1"),
        restated(None),
        Event::text_message_content("m1", "hi"),
        tagged(Event::text_message_end("m1"), "s1"),
    ];
    let events =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::MessagesSnapshot,
            EventType::RunFinished,
        ],
        "{events:?}"
    );
}

/// A state event minted from a subagent's tool result is the subagent's
/// work, so it carries the result's attribution.
#[test]
fn a_promoted_state_carries_the_results_attribution() {
    let mut promote = ToolResultToState::snapshot("load");
    promote.transform(Event::tool_call_start("c1", "load").with_subagent_run_id("s1"));
    let result = Event::tool_call_result("m1", "c1", r#"{"a":1}"#).with_subagent_run_id("s1");
    let out = promote.transform(result);
    assert_eq!(out.len(), 2);
    assert_eq!(out[1].event_type(), EventType::StateSnapshot);
    assert_eq!(out[1].subagent_run_id().map(|id| id.as_str()), Some("s1"));
}

// ---- a conversation that is restated ----------------------------------------

/// The turn as the agent holds it: a public call and two calls to the tool
/// the filter is about, one of them the only thing its message carries.
fn restated_turn() -> Vec<ag_ui::Message> {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let mut sealed = ToolCall::new("c-private-2", "secret_tool", r#"{"dump":"again"}"#);
    sealed.encrypted_value = Some("opaque-signature".into());
    vec![
        Message::user("u1", "Look it up."),
        Message::Assistant(AssistantMessage {
            id: "a1".into(),
            content: Some("Looking.".into()),
            tool_calls: Some(vec![
                ToolCall::new("c-public", "search", r#"{"q":"rust"}"#),
                ToolCall::new("c-private", "secret_tool", r#"{"dump":true}"#),
            ]),
            ..Default::default()
        }),
        Message::tool("t1", "c-public", "1 hit"),
        Message::tool("t2", "c-private", "everything"),
        Message::Assistant(AssistantMessage {
            id: "a2".into(),
            tool_calls: Some(vec![sealed]),
            ..Default::default()
        }),
        Message::tool("t3", "c-private-2", "everything, again"),
        Message::assistant("a3", "Done."),
    ]
}

/// What a restated conversation may hold once the filter has been through
/// it: the public call and its answer, and nothing of the other tool.
fn assert_only_the_public_call(messages: &[ag_ui::Message], what: &str) {
    let ids: Vec<&str> = messages.iter().map(|m| m.id().as_str()).collect();
    assert_eq!(ids, ["u1", "a1", "t1", "a3"], "{what}");
    let ag_ui::Message::Assistant(assistant) = &messages[1] else {
        panic!("{what}: a1 is an assistant message");
    };
    assert_eq!(assistant.content.as_deref(), Some("Looking."), "{what}");
    let calls: Vec<&str> = assistant
        .tool_calls
        .iter()
        .flatten()
        .map(|call| call.id.as_str())
        .collect();
    assert_eq!(calls, ["c-public"], "{what}");
}

/// Nothing the filtered tool's calls carried is on the wire: not its name,
/// its arguments, its results or the opaque value attached to a call.
fn assert_never_mentioned(events: &[Event], what: &str) {
    let wire = serde_json::to_string(events).expect("serializes");
    for secret in [
        "secret_tool",
        "dump",
        "everything",
        "c-private",
        "opaque-signature",
    ] {
        assert!(!wire.contains(secret), "{what}: {secret} is in {wire}");
    }
}

/// Makes the calls, then restates the turn.
struct Restates;

impl Agent for Restates {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        let mut public = ctx.tool_call_with_id("c-public", "search")?;
        public.args(r#"{"q":"rust"}"#)?;
        public.result("1 hit")?;
        let mut private = ctx.tool_call_with_id("c-private", "secret_tool")?;
        private.args(r#"{"dump":true}"#)?;
        private.result("everything")?;
        ctx.emit(Event::messages_snapshot(restated_turn()))?;
        Ok(RunOutcome::Success)
    }
}

/// The filter's promise is a stream that never mentions the tool, and a
/// `MESSAGES_SNAPSHOT` is part of the stream.
#[tokio::test]
async fn a_filtered_call_is_not_in_a_restated_conversation_either() {
    for (list, filter) in [
        ("deny", FilterToolCalls::deny(["secret_tool"])),
        ("allow", FilterToolCalls::allow(["search"])),
    ] {
        let events = collect(Runner::new(Restates).transformer(filter)).await;
        assert_eq!(
            events.last().map(Event::event_type),
            Some(EventType::RunFinished),
            "{list}: {events:?}"
        );
        assert_never_mentioned(&events, list);
        let snapshot = events
            .iter()
            .find_map(|event| match event {
                Event::MessagesSnapshot(snapshot) => Some(snapshot),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{list}: the snapshot is kept: {events:?}"));
        assert_only_the_public_call(&snapshot.messages, list);
    }
}

/// The same for the request echoed on `RUN_STARTED`.
#[tokio::test]
async fn a_filtered_call_is_not_in_the_echoed_input_either() {
    struct Idle;
    impl Agent for Idle {
        type State = serde_json::Value;
        async fn run(&self, _ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
            Ok(RunOutcome::Success)
        }
    }

    for (list, filter) in [
        ("deny", FilterToolCalls::deny(["secret_tool"])),
        ("allow", FilterToolCalls::allow(["search"])),
    ] {
        let mut input = RunAgentInput::new("t", "r");
        input.messages = restated_turn();
        let events: Vec<Event> = Runner::new(Idle)
            .echo_input(true)
            .transformer(filter)
            .run(input)
            .collect()
            .await;
        assert_never_mentioned(&events, list);
        let Some(Event::RunStarted(started)) = events.first() else {
            panic!("{list}: {events:?}");
        };
        let echoed = started.input.as_ref().expect("the input is echoed");
        assert_only_the_public_call(&echoed.messages, list);
    }
}

/// A call the run learns of from a snapshot is judged by its name like any
/// other, so its result goes where the call went.
#[tokio::test]
async fn a_call_a_snapshot_introduced_is_answered_or_filtered_by_its_name() {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let script = vec![
        Event::messages_snapshot(vec![Message::Assistant(AssistantMessage {
            id: "a1".into(),
            tool_calls: Some(vec![
                ToolCall::new("c-public", "search", "{}"),
                ToolCall::new("c-private", "secret_tool", "{}"),
            ]),
            ..Default::default()
        })]),
        Event::tool_call_result("t1", "c-public", "1 hit"),
        Event::tool_call_result("t2", "c-private", "everything"),
    ];
    let events =
        collect(Runner::new(Replay(script)).transformer(FilterToolCalls::deny(["secret_tool"])))
            .await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::MessagesSnapshot,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ],
        "{events:?}"
    );
    let Event::ToolCallResult(result) = &events[2] else {
        unreachable!("asserted above");
    };
    assert_eq!(result.tool_call_id.as_str(), "c-public");
    assert_never_mentioned(&events, "a call from a snapshot");
}

// ---- a tool result that is promoted to state --------------------------------

/// Reports a tool result whose patch has a path that is no JSON Pointer,
/// with state published before it or not.
struct MalformedPatch {
    published: bool,
}

impl Agent for MalformedPatch {
    type State = serde_json::Value;

    async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
        if self.published {
            ctx.set_state(&json!({"step": 1}))?;
        }
        ctx.tool_call("patch_state")?
            .result(r#"[{"op":"add","path":"oops","value":1}]"#)?;
        Ok(RunOutcome::Success)
    }
}

/// A result that is not a JSON Patch is left alone, as one that is not JSON
/// is: the run goes on, and no state event a consumer has to refuse is sent.
#[tokio::test]
async fn a_result_whose_patch_is_malformed_is_not_promoted() {
    for published in [true, false] {
        let events = collect(
            Runner::new(MalformedPatch { published })
                .transformer(ToolResultToState::delta("patch_state")),
        )
        .await;
        let types: Vec<_> = events.iter().map(Event::event_type).collect();
        let mut expected = vec![EventType::RunStarted];
        if published {
            expected.push(EventType::StateSnapshot);
        }
        expected.extend([
            EventType::ToolCallStart,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ]);
        assert_eq!(types, expected, "state published: {published}: {events:?}");

        #[cfg(feature = "client")]
        {
            let mut applier = Applier::new();
            for event in &events {
                applier
                    .apply(event)
                    .unwrap_or_else(|error| panic!("{event:?} should apply: {error}"));
            }
        }
    }
}

/// The sink does not send a `STATE_DELTA` a consumer has to treat as
/// malformed, whether or not it knows the state the delta patches.
#[tokio::test]
async fn a_state_delta_with_a_malformed_pointer_is_refused_with_or_without_a_baseline() {
    struct EmitsMalformed {
        published: bool,
    }
    impl Agent for EmitsMalformed {
        type State = serde_json::Value;
        async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
            if self.published {
                ctx.set_state(&json!({"step": 1}))?;
            }
            let malformed = Event::state_delta(vec![ag_ui::PatchOperation::add("oops", 1)]);
            assert!(ctx.emit(malformed).is_err(), "the emit is refused");
            // A patch that is well formed and does not apply is another
            // matter: a consumer reports it and keeps the state it has.
            ctx.emit(Event::state_delta(vec![ag_ui::PatchOperation::replace(
                "/missing/deep",
                1,
            )]))?;
            Ok(RunOutcome::Success)
        }
    }

    for published in [true, false] {
        let events = collect(Runner::new(EmitsMalformed { published })).await;
        let deltas: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Event::StateDelta(delta) => Some(delta.delta[0].path()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, ["/missing/deep"], "state published: {published}");
        assert_eq!(
            events.last().map(Event::event_type),
            Some(EventType::RunFinished),
            "state published: {published}: {events:?}"
        );
    }
}

/// The request's history, with a call to the tool whose result is the state
/// left unanswered, and one already answered.
fn resumed_with_a_load() -> RunAgentInput {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let mut input = RunAgentInput::new("t", "r-2");
    input.messages = vec![
        Message::Assistant(AssistantMessage {
            id: "a0".into(),
            tool_calls: Some(vec![
                ToolCall::new("c-answered", "load_document", "{}"),
                ToolCall::new("c0", "load_document", "{}"),
            ]),
            ..Default::default()
        }),
        Message::tool("t0", "c-answered", r#"{"title":"Old"}"#),
    ];
    input
}

/// A resumed run answers a call the interrupted run made. Its result is
/// promoted as the result of a call made in the same run is.
#[tokio::test]
async fn a_result_for_a_call_an_earlier_run_made_is_promoted_too() {
    let script = vec![Event::tool_call_result("m1", "c0", r#"{"title":"Notes"}"#)];
    let events: Vec<Event> = Runner::new(Replay(script))
        .transformer(ToolResultToState::snapshot("load_document"))
        .run(resumed_with_a_load())
        .collect()
        .await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::ToolCallResult,
            EventType::StateSnapshot,
            EventType::RunFinished,
        ],
        "{events:?}"
    );
    assert_eq!(events[2], Event::state_snapshot(json!({"title": "Notes"})));
}

// ---- chunks whose lane a filter moves ---------------------------------------

/// One `TOOL_CALL_CHUNK` that names its call. `opener` is what only the
/// first chunk of a call carries: the tool, and the message the call sits in.
#[cfg(feature = "client")]
fn named_tool_chunk(id: &str, opener: Option<(&str, Option<&str>)>, delta: &str) -> Event {
    let mut chunk = ag_ui::ToolCallChunkEvent::new(
        Some(ToolCallId::new(id)),
        opener.map(|(name, _)| name.to_owned()),
        Some(delta.to_owned()),
    );
    chunk.parent_message_id = opener.and_then(|(_, parent)| parent.map(Into::into));
    chunk.into()
}

/// What a client holds of a run, having read it by its own rules: the
/// normalizer, the verifier, then the fold.
#[cfg(feature = "client")]
fn read_by_a_client(events: Vec<Event>) -> Applier {
    use ag_ui::client::verify_all;
    assert_eq!(
        events.last().map(Event::event_type),
        Some(EventType::RunFinished),
        "{events:?}"
    );
    let events = normalize_all(events).expect("normalizes");
    verify_all(&events).unwrap_or_else(|error| panic!("{error}\n{events:?}"));
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    applier
}

/// Every tool call a client holds: the message it sits in, its id, its
/// name and its arguments.
#[cfg(feature = "client")]
fn calls_held(applier: &Applier) -> Vec<(String, String, String, String)> {
    applier
        .messages()
        .iter()
        .filter_map(|message| match message {
            ag_ui::Message::Assistant(assistant) => Some(assistant),
            _ => None,
        })
        .flat_map(|assistant| {
            assistant.tool_calls.iter().flatten().map(|call| {
                (
                    assistant.id.as_str().to_owned(),
                    call.id.as_str().to_owned(),
                    call.function.name.clone(),
                    call.function.arguments.clone(),
                )
            })
        })
        .collect()
}

/// Two subagents stream a tool call each, at once. Every chunk is tagged and
/// names its call; the tool and the message that carries the call are named
/// on the first chunk only, as the chunked form has it.
#[cfg(feature = "client")]
fn two_subagents_streaming_calls() -> Vec<Event> {
    let tagged = |chunk: Event, id: &str| chunk.with_subagent_run_id(id);
    vec![
        Event::subagent_started("s1", "researcher"),
        Event::subagent_started("s2", "writer"),
        tagged(
            named_tool_chunk("c1", Some(("search", Some("a-s1"))), r#"{"q":"#),
            "s1",
        ),
        tagged(
            named_tool_chunk("c2", Some(("draft", None)), r#"{"title":"#),
            "s2",
        ),
        tagged(named_tool_chunk("c1", None, r#""rust"}"#), "s1"),
        tagged(named_tool_chunk("c2", None, r#""Notes"}"#), "s2"),
        Event::subagent_finished_success("s1"),
        Event::subagent_finished_success("s2"),
    ]
}

/// With the tags gone the two calls share the parent's lane, where each
/// chunk ends the other call's stream: the continuation opens its call again
/// on the consuming side, and has to carry what opens it.
#[cfg(feature = "client")]
#[tokio::test]
async fn inline_reopens_a_call_whose_stream_another_subagents_chunk_ended() {
    let expected = [
        (
            "a-s1".to_owned(),
            "c1".to_owned(),
            "search".to_owned(),
            r#"{"q":"rust"}"#.to_owned(),
        ),
        (
            "c2-message".to_owned(),
            "c2".to_owned(),
            "draft".to_owned(),
            r#"{"title":"Notes"}"#.to_owned(),
        ),
    ];
    let attributed = collect(Runner::new(Replay(two_subagents_streaming_calls()))).await;
    assert_eq!(calls_held(&read_by_a_client(attributed)), expected);

    let inline = collect(
        Runner::new(Replay(two_subagents_streaming_calls()))
            .transformer(SubagentVisibility::inline()),
    )
    .await;
    assert_eq!(calls_held(&read_by_a_client(inline)), expected);
}

/// The state a subagent publishes is kept, as the parent's, and ends the
/// parent's chunk stream on the consuming side. The parent's next chunk opens
/// its call, or its message, again there.
#[cfg(feature = "client")]
#[tokio::test]
async fn hidden_reopens_what_a_subagents_state_ended_on_the_consuming_side() {
    let published = || Event::state_snapshot(json!({"done": 1})).with_subagent_run_id("s1");
    let script = vec![
        Event::subagent_started("s1", "worker"),
        named_tool_chunk("c1", Some(("search", Some("a1"))), r#"{"q":"#),
        published(),
        named_tool_chunk("c1", None, r#""rust"}"#),
        Event::tool_call_result("t1", "c1", "1 hit"),
        Event::subagent_finished_success("s1"),
    ];
    let expected = [(
        "a1".to_owned(),
        "c1".to_owned(),
        "search".to_owned(),
        r#"{"q":"rust"}"#.to_owned(),
    )];
    let attributed = collect(Runner::new(Replay(script.clone()))).await;
    assert_eq!(calls_held(&read_by_a_client(attributed)), expected);
    let hidden =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
    assert_eq!(calls_held(&read_by_a_client(hidden)), expected);

    // A message keeps the role and the name it was opened with.
    let mut opening =
        ag_ui::TextMessageChunkEvent::new(Some("m1".into()), Some("Remember ".to_owned()));
    opening.role = Some(ag_ui::TextMessageRole::Developer);
    opening.name = Some("policy".to_owned());
    let script = vec![
        Event::subagent_started("s1", "worker"),
        Event::from(opening),
        published(),
        Event::text_message_chunk(Some("m1".into()), Some("this.".to_owned())),
        Event::subagent_finished_success("s1"),
    ];
    let hidden =
        collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
    let reopening = hidden
        .iter()
        .filter_map(|event| match event {
            Event::TextMessageChunk(chunk) => Some(chunk),
            _ => None,
        })
        .nth(1)
        .expect("the continuation is kept");
    assert_eq!(reopening.role, Some(ag_ui::TextMessageRole::Developer));
    assert_eq!(reopening.name.as_deref(), Some("policy"));
    let applier = read_by_a_client(hidden);
    assert_eq!(applier.text_of("m1"), Some("Remember this."));
    assert!(
        matches!(applier.messages(), [ag_ui::Message::Developer(_)]),
        "{:?}",
        applier.messages()
    );
}

#[cfg(feature = "client")]
#[tokio::test]
async fn hidden_snapshots_keep_only_previously_delivered_open_parent_content() {
    use ag_ui::{AssistantMessage, Message};
    for omit in [false, true] {
        let mut snapshot = vec![Message::user("u", "a visible question")];
        if !omit {
            snapshot.push(Message::Assistant(AssistantMessage {
                id: "m".into(),
                content: Some("worker draft".into()),
                subagent_run_id: Some("worker".into()),
                ..Default::default()
            }));
        }
        let mut call = Event::tool_call_start("c", "search");
        let Event::ToolCallStart(start) = &mut call else {
            unreachable!()
        };
        start.parent_message_id = Some("m".into());
        let script = vec![
            Event::text_message_start("m", Default::default()),
            Event::text_message_content("m", "hello")
                .with_metadata(json!({"label":"parent"}).as_object().unwrap().clone()),
            call,
            Event::tool_call_args("c", "{}"),
            Event::tool_call_end("c"),
            Event::messages_snapshot(snapshot),
            Event::text_message_content("m", " world"),
            Event::text_message_end("m"),
        ];
        let events =
            collect(Runner::new(Replay(script)).transformer(SubagentVisibility::hidden())).await;
        assert!(
            !serde_json::to_string(&events)
                .unwrap()
                .contains("worker draft")
        );
        let parent = events
            .iter()
            .find_map(|event| match event {
                Event::MessagesSnapshot(s) => s.messages.iter().find(|m| m.id().as_str() == "m"),
                _ => None,
            })
            .unwrap();
        let Message::Assistant(parent) = parent else {
            unreachable!()
        };
        assert_eq!(parent.metadata.as_ref().unwrap()["label"], "parent");
        assert_eq!(
            parent.tool_calls.as_ref().unwrap()[0].function.arguments,
            "{}"
        );
        assert_eq!(
            assembled(events),
            [("m".to_owned(), "hello world".to_owned())]
        );
    }
}

#[test]
fn hidden_open_history_keeps_its_calls_and_results_together() {
    use ag_ui::Message;
    let mut filter = SubagentVisibility::hidden();
    let child = Event::text_message_start("m", Default::default()).with_subagent_run_id("worker");
    assert!(filter.transform(child).is_empty());
    let first = filter.transform(Event::messages_snapshot(vec![Message::assistant(
        "m", "draft",
    )]));
    assert!(matches!(&first[..], [Event::MessagesSnapshot(s)] if s.messages.is_empty()));
    let messages: Vec<Message> = serde_json::from_value(json!([
        {"role":"assistant","id":"m","toolCalls":[{"type":"function","id":"c","function":{"name":"search","arguments":"{}"}}]},
        {"role":"tool","id":"r","toolCallId":"c","content":"draft"},
        {"role":"user","id":"u","content":"visible"}
    ])).unwrap();
    let out = filter.transform(Event::messages_snapshot(messages));
    let Event::MessagesSnapshot(snapshot) = &out[0] else {
        unreachable!()
    };
    assert_eq!(snapshot.messages, vec![Message::user("u", "visible")]);
    assert!(
        filter
            .transform(Event::tool_call_result("r", "c", "draft"))
            .is_empty()
    );
}

#[test]
fn a_snapshot_can_remove_a_parent_chunk_stream_that_has_implicitly_ended() {
    let mut filter = SubagentVisibility::hidden();
    for id in ["first", "second"] {
        filter.transform(Event::text_message_chunk(
            Some(id.into()),
            Some("hello".into()),
        ));
    }
    let out = filter.transform(Event::messages_snapshot(vec![]));
    let Event::MessagesSnapshot(snapshot) = &out[0] else {
        unreachable!()
    };
    assert_eq!(
        snapshot.messages,
        vec![ag_ui::Message::assistant("second", "hello")]
    );
}

#[test]
fn an_ended_child_chunk_does_not_hide_a_later_parent_snapshot() {
    let mut filter = SubagentVisibility::hidden();
    for id in ["first", "second"] {
        let chunk = Event::text_message_chunk(Some(id.into()), Some("draft".into()));
        assert!(
            filter
                .transform(chunk.with_subagent_run_id("worker"))
                .is_empty()
        );
    }
    let visible = ag_ui::Message::assistant("first", "published");
    let snapshot = Event::messages_snapshot(vec![visible]);
    assert_eq!(filter.transform(snapshot.clone()), [snapshot]);
}

#[test]
fn a_snapshot_exposes_the_result_of_a_previously_hidden_call() {
    use ag_ui::{AssistantMessage, Message, ToolCall};
    let mut filter = SubagentVisibility::hidden();
    for event in [
        Event::tool_call_start("c", "search"),
        Event::tool_call_end("c"),
    ] {
        assert!(
            filter
                .transform(event.with_subagent_run_id("worker"))
                .is_empty()
        );
    }
    let message = Message::Assistant(AssistantMessage {
        id: "m".into(),
        tool_calls: Some(vec![ToolCall::new("c", "search", "{}")]),
        ..Default::default()
    });
    let snapshot = Event::messages_snapshot(vec![message]);
    assert_eq!(filter.transform(snapshot.clone()), [snapshot]);
    let result = Event::tool_call_result("r", "c", "published");
    assert_eq!(filter.transform(result.clone()), [result]);
}

#[test]
fn hidden_results_and_unknown_child_activities_keep_their_attribution() {
    use ag_ui::ReasoningEncryptedValueSubtype;
    let mut filter = SubagentVisibility::hidden();
    for event in [
        Event::tool_call_start("c", "search"),
        Event::tool_call_end("c"),
    ] {
        assert!(
            filter
                .transform(event.with_subagent_run_id("worker"))
                .is_empty()
        );
    }
    assert!(
        filter
            .transform(Event::tool_call_result("r", "c", "private"))
            .is_empty()
    );
    assert!(
        filter
            .transform(Event::reasoning_encrypted_value(
                ReasoningEncryptedValueSubtype::Message,
                "r",
                "opaque"
            ))
            .is_empty()
    );
    let delta = Event::activity_delta("a", "progress", vec![]).with_subagent_run_id("worker");
    assert!(filter.transform(delta).is_empty());
}
