//! `*_CHUNK` events driven through the whole stack.
//!
//! A chunk carries its id only on the *first* chunk of a stream, and the end of
//! one stream is only knowable from the start of the next. The client's
//! normalizer is the thing that remembers; this drives real chunk events over
//! real HTTP and checks what comes out the other side — including two message
//! streams in one run, a return to the first one, all three chunk families
//! interleaved, and a chunk-streamed tool call the agent answers itself.

mod common;

use ag_ui::client::{RemoteAgent, RunParams, Thread, Update};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{AssistantMessage, Event, EventType, Message, MessageId, RunOutcome, ToolCallId};
use common::{serve, transport};
use futures_util::StreamExt as _;

/// Speaks only in chunks, the way a provider adapter that cannot bracket its
/// output does.
struct Chunky;

impl Agent for Chunky {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        // Reasoning first — one id, then two bare continuations.
        ctx.emit(chunk_reasoning(Some("think-1"), "Two things "))?;
        ctx.emit(chunk_reasoning(None, "to say, then "))?;
        ctx.emit(chunk_reasoning(None, "a lookup."))?;

        // The first message.
        ctx.emit(chunk_text(Some("say-1"), "Hello"))?;
        ctx.emit(chunk_text(None, ", "))?;
        ctx.emit(chunk_text(None, "world"))?;

        // Naming a second id is the only thing that ends the first message.
        ctx.emit(chunk_text(Some("say-2"), "Good"))?;
        ctx.emit(chunk_text(None, "bye"))?;

        // A tool call, likewise: id and name on the opening chunk only.
        ctx.emit(Event::tool_call_chunk(
            Some(ToolCallId::new("call-1")),
            Some("search".to_owned()),
            Some(r#"{"q":"#.to_owned()),
        ))?;
        ctx.emit(Event::tool_call_chunk(
            None,
            None,
            Some(r#""rust"}"#.to_owned()),
        ))?;

        // …and back to the first message, which has to be reopened and
        // appended to rather than duplicated.
        ctx.emit(chunk_text(Some("say-1"), "!"))?;

        Ok(RunOutcome::Success)
    }
}

/// Chunk-streams a tool call and then answers it — what an adapter does when
/// the tool runs on the agent's side.
struct ChunkyToolUser;

impl Agent for ChunkyToolUser {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::tool_call_chunk(
            Some(ToolCallId::new("call-1")),
            Some("get_weather".to_owned()),
            Some(r#"{"city":"#.to_owned()),
        ))?;
        ctx.emit(Event::tool_call_chunk(
            None,
            None,
            Some(r#""Seoul"}"#.to_owned()),
        ))?;
        // No `TOOL_CALL_END`: a chunk-streamed call has none of its own, and
        // the server's verifier accepts the result all the same.
        ctx.emit(Event::tool_call_result("msg-1", "call-1", r#"{"temp":21}"#))?;
        ctx.emit(chunk_text(Some("say-1"), "It is 21 degrees."))?;
        Ok(RunOutcome::Success)
    }
}

fn chunk_text(id: Option<&str>, delta: &str) -> Event {
    Event::text_message_chunk(id.map(MessageId::new), Some(delta.to_owned()))
}

fn chunk_reasoning(id: Option<&str>, delta: &str) -> Event {
    Event::reasoning_message_chunk(id.map(MessageId::new), Some(delta.to_owned()))
}

/// What the agent emitted is what went on the wire: the endpoint does not
/// expand chunks on the server's behalf, and continuations carry no id.
#[tokio::test(flavor = "multi_thread")]
async fn chunks_travel_as_chunks_and_only_the_first_names_its_stream() {
    let url = serve(Chunky).await;
    let agent = RemoteAgent::new(transport(&url));

    let mut events = Vec::new();
    let mut stream = agent.run_events(RunParams::new("chunky", "chunky-run-1"));
    while let Some(event) = stream.next().await {
        events.push(event.expect("the stream should not break"));
    }

    let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
    use EventType::{
        ReasoningMessageChunk, RunFinished, RunStarted, TextMessageChunk, ToolCallChunk,
    };
    assert_eq!(
        types,
        [
            RunStarted,
            ReasoningMessageChunk,
            ReasoningMessageChunk,
            ReasoningMessageChunk,
            TextMessageChunk,
            TextMessageChunk,
            TextMessageChunk,
            TextMessageChunk,
            TextMessageChunk,
            ToolCallChunk,
            ToolCallChunk,
            TextMessageChunk,
            RunFinished,
        ]
    );

    let named: Vec<Option<&str>> = events
        .iter()
        .filter_map(|event| match event {
            Event::TextMessageChunk(chunk) => {
                Some(chunk.message_id.as_ref().map(MessageId::as_str))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        named,
        [
            Some("say-1"),
            None,
            None,
            Some("say-2"),
            None,
            Some("say-1")
        ],
        "a continuation chunk must not repeat the id"
    );
}

/// Two message streams in one run, reassembled without bleeding into each
/// other.
#[tokio::test(flavor = "multi_thread")]
async fn interleaved_chunk_streams_reassemble_into_separate_messages() {
    let url = serve(Chunky).await;
    let mut thread = Thread::<_>::new(transport(&url), "chunky");

    {
        let mut run = thread
            .send_message(Message::user("chunky-msg-1", "say two things"))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("a chunked run should not produce an error: {error}");
            }
        }
    }

    let expected = vec![
        Message::user("chunky-msg-1", "say two things"),
        Message::assistant("say-1", "Hello, world!"),
        Message::assistant("say-2", "Goodbye"),
        Message::Assistant(AssistantMessage {
            id: "call-1-message".into(),
            content: None,
            tool_calls: Some(vec![ag_ui::ToolCall::new(
                "call-1",
                "search",
                r#"{"q":"rust"}"#,
            )]),
            ..Default::default()
        }),
    ];
    assert_eq!(thread.messages(), expected.as_slice());
}

/// The two halves have to agree about a chunk-streamed call and its result.
///
/// The server's verifier accepts a `TOOL_CALL_RESULT` for a call opened by a
/// chunk — there is no `TOOL_CALL_END` to wait for — so the client's normalizer
/// has to emit the terminator it owes *before* passing the result on. When it
/// did not, the client's own verifier rejected the result, the rejected event
/// was never applied, and the tool message vanished from a run the client still
/// reported a success. Nothing short of both halves running together catches a
/// disagreement between them.
#[tokio::test(flavor = "multi_thread")]
async fn a_chunk_streamed_call_answered_by_the_agent_survives_the_round_trip() {
    let url = serve(ChunkyToolUser).await;
    let mut thread = Thread::<_>::new(transport(&url), "chunky");

    let mut errors = Vec::new();
    {
        let mut run = thread
            .send_message(Message::user("chunky-msg-1", "what is the weather?"))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                errors.push(error.to_string());
            }
        }
    }
    assert!(errors.is_empty(), "unexpected errors: {errors:?}");

    let expected = vec![
        Message::user("chunky-msg-1", "what is the weather?"),
        Message::Assistant(AssistantMessage {
            id: "call-1-message".into(),
            content: None,
            tool_calls: Some(vec![ag_ui::ToolCall::new(
                "call-1",
                "get_weather",
                r#"{"city":"Seoul"}"#,
            )]),
            ..Default::default()
        }),
        Message::tool("msg-1", "call-1", r#"{"temp":21}"#),
        Message::assistant("say-1", "It is 21 degrees."),
    ];
    assert_eq!(thread.messages(), expected.as_slice());
}

/// Reasoning chunks land in the reasoning pane, not the transcript, and the
/// stream that opened first is not closed by the ones that follow it.
#[tokio::test(flavor = "multi_thread")]
async fn reasoning_chunks_reassemble_separately_from_the_reply() {
    let url = serve(Chunky).await;
    let mut thread = Thread::<_>::new(transport(&url), "chunky");

    {
        let mut run = thread
            .send_message(Message::user("chunky-msg-1", "say two things"))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("a chunked run should not produce an error: {error}");
            }
        }
    }

    let reasoning = thread.reasoning();
    assert_eq!(reasoning.len(), 1, "{reasoning:?}");
    assert_eq!(reasoning[0].id.as_str(), "think-1");
    assert_eq!(reasoning[0].content, "Two things to say, then a lookup.");
}

/// The last stream of a run has nothing after it to imply its end, so the
/// normalizer has to close it when the run finishes.
#[tokio::test(flavor = "multi_thread")]
async fn the_final_chunk_stream_is_closed_by_the_end_of_the_run() {
    let url = serve(Chunky).await;
    let mut thread = Thread::<_>::new(transport(&url), "chunky");

    let mut ended_ids = Vec::new();
    {
        let mut run = thread
            .send_message(Message::user("chunky-msg-1", "say two things"))
            .expect("run preflight");
        while let Some(update) = run.next().await {
            match update {
                Update::Message(message) => {
                    if matches!(message.change, ag_ui::client::MessageChangeKind::Ended) {
                        ended_ids.push(message.id.to_string());
                    }
                }
                // A stream the normalizer complained about would explain a
                // missing terminator without the assertion below saying so.
                Update::Error(error) => panic!("a chunked run should not error: {error}"),
                _ => {}
            }
        }
    }

    assert_eq!(
        ended_ids,
        ["say-1", "say-2", "say-1"],
        "every opened stream must be closed, the last one by the run ending"
    );
}
