mod lifecycle_support;
use ag_ui_client::{
    Agent,
    agent::{AgentError, AgentStateMutation},
    core::{
        JsonValue,
        event::Event,
        types::{Message, RunAgentInput},
    },
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use futures::stream::{self, BoxStream};
use lifecycle_support::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn call(id: &str, args: &str) -> Message {
    message(
        json!({"id":id,"role":"assistant","toolCalls":[{"id":"call","type":"function","function":{"name":"search","arguments":args}}]}),
    )
}
fn ids(messages: &[Message]) -> Vec<&str> {
    messages.iter().map(|m| m.id().as_ref()).collect()
}

#[tokio::test]
async fn snapshot_replaces_result_id_without_detaching_it_from_call() {
    let mut input = input("r");
    input.messages = vec![
        call("a", "{}"),
        message(json!({"id":"stream","role":"tool","toolCallId":"call","content":"old"})),
        message(json!({"id":"reply","role":"assistant","content":"answer"})),
    ];
    let result = Script(vec![start("r"), json!({"type":"MESSAGES_SNAPSHOT","messages":[values(&input.messages)[0],{"id":"server","role":"tool","toolCallId":"call","content":"new"},values(&input.messages)[2]]}), finish("r")]).run_input(&input, ()).await.unwrap();
    assert_eq!(ids(&result.messages), ["a", "server", "reply"]);
}

#[tokio::test]
async fn streamed_results_preserve_colliding_assistant_and_update_only_matching_result() {
    let mut input = input("r");
    input.messages = vec![
        call("a", "{}"),
        message(json!({"id":"collision","role":"assistant","content":"answer"})),
    ];
    let result = Script(vec![start("r"), json!({"type":"TOOL_CALL_RESULT","messageId":"collision","toolCallId":"call","content":"old","metadata":{"kept":true}}), json!({"type":"TOOL_CALL_RESULT","messageId":"collision","toolCallId":"call","content":"new","metadata":{"added":true}}), finish("r")]).run_input(&input, ()).await.unwrap();
    assert_eq!(ids(&result.messages), ["a", "collision", "collision"]);
    let messages = values(&result.messages);
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["content"], "new");
    assert_eq!(messages[1]["metadata"], json!({"kept":true,"added":true}));
    assert_eq!(messages[2]["role"], "assistant");
}

#[tokio::test]
async fn late_stream_result_uses_newest_unanswered_call() {
    let mut input = input("r");
    input.messages = vec![
        call("first", "{}"),
        message(json!({"id":"t1","role":"tool","toolCallId":"call","content":"first"})),
        call("second", "{}"),
        message(json!({"id":"reply","role":"assistant","content":"answer"})),
    ];
    let result = Script(vec![
        start("r"),
        json!({"type":"TOOL_CALL_RESULT","messageId":"t2","toolCallId":"call","content":"second"}),
        finish("r"),
    ])
    .run_input(&input, ())
    .await
    .unwrap();
    assert_eq!(
        ids(&result.messages),
        ["first", "t1", "second", "t2", "reply"]
    );
}

#[tokio::test]
async fn resumed_args_replace_once_but_start_only_preserves_saved_arguments() {
    for with_args in [false, true] {
        let mut input = input("r");
        input.messages = vec![call("a", "{\"old\":true}")];
        let mut events = vec![
            start("r"),
            json!({"type":"TOOL_CALL_START","toolCallId":"call","toolCallName":"renamed","parentMessageId":"a"}),
        ];
        if with_args {
            events.push(json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"{\"new\":"}));
            events.push(json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"true}"}));
        }
        events.extend([
            json!({"type":"TOOL_CALL_END","toolCallId":"call"}),
            finish("r"),
        ]);
        let result = Script(events).run_input(&input, ()).await.unwrap();
        let messages = values(&result.messages);
        assert_eq!(messages[0]["toolCalls"].as_array().unwrap().len(), 1);
        assert_eq!(
            messages[0]["toolCalls"][0]["function"]["arguments"],
            if with_args {
                "{\"new\":true}"
            } else {
                "{\"old\":true}"
            }
        );
        assert_eq!(messages[0]["toolCalls"][0]["function"]["name"], "renamed");
    }
}

#[tokio::test]
async fn run_started_echo_appends_unseen_messages_without_overwriting_local_history() {
    let mut input = input("r");
    input.messages = vec![message(
        json!({"id":"local","role":"user","content":"keep"}),
    )];
    let mut echoed = input.clone();
    echoed.messages = vec![
        message(json!({"id":"local","role":"user","content":"do not overwrite"})),
        call("echo", "{}"),
        call("echo", "{}"),
    ];
    let result = Script(vec![
        json!({"type":"RUN_STARTED","threadId":"thread","runId":"r","input":echoed}),
        finish("r"),
    ])
    .run_input(&input, ())
    .await
    .unwrap();
    assert_eq!(ids(&result.messages), ["local", "echo"]);
    assert_eq!(values(&result.messages)[0]["content"], "keep");
    assert_eq!(ids(&result.new_messages), ["echo"]);
}

struct Capture(Arc<Mutex<Option<RunAgentInput>>>);
#[async_trait::async_trait]
impl Agent for Capture {
    async fn run(
        &self,
        input: &RunAgentInput,
    ) -> Result<BoxStream<'async_trait, Result<Event, AgentError>>, AgentError> {
        *self.0.lock().unwrap() = Some(input.clone());
        Ok(Box::pin(stream::iter(vec![
            Ok(event(start("r"))),
            Ok(event(finish("r"))),
        ])))
    }
}
struct Initialize;
#[async_trait::async_trait]
impl AgentSubscriber for Initialize {
    async fn on_run_initialized(
        &self,
        _params: AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
    ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
        Ok(AgentStateMutation {
            messages: Some(vec![
                call("a", "{}"),
                message(json!({"id":"reply","role":"assistant","content":"answer"})),
                message(json!({"id":"tool","role":"tool","toolCallId":"call","content":"result"})),
            ]),
            state: Some(json!({"initialized":true})),
            ..Default::default()
        })
    }
}
#[tokio::test]
async fn initialization_mutations_reach_transport_with_repaired_history() {
    let captured = Arc::new(Mutex::new(None));
    let mut input = input("r");
    input.forwarded_props = json!({"preserve":true});
    input.parent_run_id = Some("parent".into());
    Capture(captured.clone())
        .run_input(&input, (Initialize,))
        .await
        .unwrap();
    let captured = captured.lock().unwrap();
    let sent = captured.as_ref().unwrap();
    assert_eq!(sent.state, json!({"initialized":true}));
    assert_eq!(ids(&sent.messages), ["a", "tool", "reply"]);
    assert_eq!(sent.forwarded_props, input.forwarded_props);
    assert_eq!(sent.parent_run_id, input.parent_run_id);
    assert!(input.messages.is_empty());
}
