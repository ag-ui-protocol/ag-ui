//! The two verifiers agree about who owns what.
//!
//! The server verifies what it emits and the client verifies what it
//! receives, and both track subagent ownership — the first writer of an id,
//! a tool call inheriting its parent message's owner, snapshots and the
//! `RUN_STARTED` echo seeding it. A stream one side accepts and the other
//! rejects would be an agent that cannot talk to this crate's own client, so
//! every stream here is run through both and the verdicts compared, on top
//! of being pinned individually.

#![cfg(all(feature = "server", feature = "client"))]

use ag_ui::client::Verifier;
use ag_ui::server::{EventReceiver, RunContext};
use ag_ui::{
    AssistantMessage, Event, JsonObject, Message, PatchOperation, ReasoningEncryptedValueSubtype,
    RunAgentInput, TextMessageRole, ToolCall,
};

fn tagged(event: Event, id: &str) -> Event {
    event.with_subagent_run_id(id)
}

fn call_in(message: &str, id: &str) -> Event {
    let mut start = ag_ui::ToolCallStartEvent::new(id, "search");
    start.parent_message_id = Some(message.into());
    Event::ToolCallStart(start)
}

fn activity(id: &str, replace: bool) -> Event {
    let mut event = ag_ui::ActivitySnapshotEvent::new(id, "progress", JsonObject::new());
    event.replace = replace;
    Event::ActivitySnapshot(event)
}

fn delta(id: &str) -> Event {
    Event::activity_delta(id, "progress", vec![PatchOperation::add("/step", 1)])
}

fn history(owner: Option<&str>) -> Message {
    Message::Assistant(AssistantMessage {
        id: "h1".into(),
        content: Some("earlier".into()),
        tool_calls: Some(vec![ToolCall::new("hc1", "search", "{}")]),
        subagent_run_id: owner.map(Into::into),
        ..Default::default()
    })
}

fn echo(messages: Vec<Message>) -> Event {
    let mut input = RunAgentInput::new("t", "r");
    input.messages = messages;
    let mut started = ag_ui::RunStartedEvent::new("t", "r");
    started.input = Some(Box::new(input));
    Event::RunStarted(started)
}

/// Where the server first objects, if anywhere.
fn server_rejects(events: &[Event]) -> Option<usize> {
    let (mut ctx, _events): (RunContext<()>, EventReceiver) =
        RunContext::new(RunAgentInput::new("t", "r")).expect("a context");
    events
        .iter()
        .position(|event| ctx.emit(event.clone()).is_err())
}

/// Where the client first objects, if anywhere.
fn client_rejects(events: &[Event]) -> Option<usize> {
    let mut verifier = Verifier::new();
    events
        .iter()
        .position(|event| verifier.verify(event).is_err())
}

/// A stream, and the index of the event that must be rejected — `None` for
/// a stream that must pass whole.
fn corpus() -> Vec<(&'static str, Vec<Event>, Option<usize>)> {
    let start = |id: &str| Event::text_message_start(id, TextMessageRole::Assistant);
    vec![
        (
            "a tagged continuation must name the opener",
            vec![
                Event::run_started("t", "r"),
                tagged(start("m1"), "s1"),
                tagged(Event::text_message_content("m1", "x"), "s2"),
            ],
            Some(2),
        ),
        (
            "the first writer keeps the id through an untagged re-open",
            vec![
                Event::run_started("t", "r"),
                tagged(start("m1"), "s1"),
                tagged(Event::text_message_end("m1"), "s1"),
                start("m1"),
                tagged(Event::text_message_content("m1", "x"), "s1"),
                Event::text_message_end("m1"),
                tagged(call_in("m1", "c1"), "s1"),
                tagged(Event::tool_call_end("c1"), "s1"),
                Event::run_finished_success("t", "r"),
            ],
            None,
        ),
        (
            "and a sibling still may not continue it",
            vec![
                Event::run_started("t", "r"),
                tagged(start("m1"), "s1"),
                tagged(Event::text_message_end("m1"), "s1"),
                start("m1"),
                tagged(Event::text_message_content("m1", "x"), "s2"),
            ],
            Some(4),
        ),
        (
            "a tool call belongs to the message that carries it",
            vec![
                Event::run_started("t", "r"),
                tagged(start("m1"), "s1"),
                tagged(call_in("m1", "c1"), "s2"),
            ],
            Some(2),
        ),
        (
            "an untagged call inherits, so a sibling cannot continue it",
            vec![
                Event::run_started("t", "r"),
                tagged(start("m1"), "s1"),
                call_in("m1", "c1"),
                tagged(Event::tool_call_args("c1", "{}"), "s2"),
            ],
            Some(3),
        ),
        (
            "the echo seeds ownership",
            vec![echo(vec![history(Some("s1"))]), tagged(start("h1"), "s2")],
            Some(1),
        ),
        (
            "the echo seeds tool calls too",
            vec![
                echo(vec![history(Some("s1"))]),
                tagged(Event::tool_call_start("hc1", "search"), "s2"),
            ],
            Some(1),
        ),
        (
            "a snapshot is authoritative over the echo",
            vec![
                echo(vec![history(Some("s1"))]),
                Event::messages_snapshot(vec![history(None)]),
                tagged(start("h1"), "s1"),
            ],
            Some(2),
        ),
        (
            "a result mints its message under its own attribution",
            vec![
                Event::run_started("t", "r"),
                Event::tool_call_start("c1", "search"),
                Event::tool_call_end("c1"),
                tagged(Event::tool_call_result("m2", "c1", "ok"), "s1"),
                start("m2"),
                tagged(Event::text_message_end("m2"), "s2"),
            ],
            Some(5),
        ),
        (
            "a reasoning block and its message share an owner",
            vec![
                Event::run_started("t", "r"),
                tagged(Event::reasoning_start("r1"), "s1"),
                tagged(Event::reasoning_message_start("r1"), "s2"),
            ],
            Some(2),
        ),
        (
            "a text message and a reasoning message may share an id",
            vec![
                Event::run_started("t", "r"),
                tagged(start("x"), "s1"),
                tagged(Event::text_message_end("x"), "s1"),
                tagged(Event::reasoning_message_start("x"), "s2"),
                tagged(Event::reasoning_message_end("x"), "s2"),
                Event::run_finished_success("t", "r"),
            ],
            None,
        ),
        (
            "an encrypted value names the owner of its tool call",
            vec![
                Event::run_started("t", "r"),
                tagged(Event::tool_call_start("c1", "search"), "s1"),
                tagged(Event::tool_call_end("c1"), "s1"),
                tagged(
                    Event::reasoning_encrypted_value(
                        ReasoningEncryptedValueSubtype::ToolCall,
                        "c1",
                        "x",
                    ),
                    "s2",
                ),
            ],
            Some(3),
        ),
        (
            "an encrypted value names the owner of its reasoning message",
            vec![
                Event::run_started("t", "r"),
                tagged(Event::reasoning_message_start("r1"), "s1"),
                tagged(Event::reasoning_message_end("r1"), "s1"),
                tagged(
                    Event::reasoning_encrypted_value(
                        ReasoningEncryptedValueSubtype::Message,
                        "r1",
                        "x",
                    ),
                    "s2",
                ),
            ],
            Some(3),
        ),
        (
            "an activity delta names the owner of the activity",
            vec![
                Event::run_started("t", "r"),
                tagged(activity("a1", true), "s1"),
                delta("a1"),
                activity("a1", false),
                tagged(delta("a1"), "s2"),
            ],
            Some(4),
        ),
        (
            "a replacing snapshot re-owns the activity",
            vec![
                Event::run_started("t", "r"),
                tagged(activity("a1", true), "s1"),
                tagged(activity("a1", true), "s2"),
                tagged(delta("a1"), "s2"),
                Event::run_finished_success("t", "r"),
            ],
            None,
        ),
        (
            "steps are keyed by owner",
            vec![
                Event::run_started("t", "r"),
                Event::step_started("plan"),
                tagged(Event::step_started("plan"), "s1"),
                tagged(Event::step_finished("plan"), "s1"),
                tagged(Event::step_finished("plan"), "s2"),
            ],
            Some(4),
        ),
        (
            "concurrent subagents interleave under their own tags",
            vec![
                Event::run_started("t", "r"),
                Event::subagent_started("s1", "researcher"),
                Event::subagent_started("s2", "researcher"),
                tagged(start("m1"), "s1"),
                tagged(start("m2"), "s2"),
                tagged(Event::text_message_content("m1", "a"), "s1"),
                tagged(Event::text_message_content("m2", "b"), "s2"),
                tagged(Event::text_message_end("m2"), "s2"),
                Event::subagent_finished_success("s2"),
                tagged(Event::text_message_end("m1"), "s1"),
                Event::subagent_finished_success("s1"),
                Event::run_finished_success("t", "r"),
            ],
            None,
        ),
        (
            "a run may not finish with a subagent active",
            vec![
                Event::run_started("t", "r"),
                Event::subagent_started("s1", "researcher"),
                Event::run_finished_success("t", "r"),
            ],
            Some(2),
        ),
    ]
}

#[test]
fn both_verifiers_reach_the_same_verdict_on_every_stream() {
    for (name, events, expected) in corpus() {
        let server = server_rejects(&events);
        let client = client_rejects(&events);
        assert_eq!(server, expected, "server, {name}: {events:?}");
        assert_eq!(client, expected, "client, {name}: {events:?}");
    }
}
