#![cfg(feature = "client")]

use ag_ui::client::transport::{
    RawTransportFuture, ReplayTransport, Transport, TransportFuture, boxed_raw_stream,
};
use ag_ui::client::{RemoteAgent, RunParams};
use ag_ui::{Event, EventType, RunAgentInput};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

#[derive(Clone)]
struct TranslatingRawTransport {
    events: Vec<Value>,
}

impl Transport for TranslatingRawTransport {
    fn run(&self, _input: RunAgentInput) -> TransportFuture {
        panic!("the application must use the shared raw-event boundary")
    }

    fn run_raw(&self, _input: RunAgentInput) -> RawTransportFuture {
        let values = self.events.clone().into_iter().map(|mut value| {
            // A transport-owned compatibility shim sees the raw shape before
            // the shared 1.0 boundary removes unknown event types.
            if value["type"] == "LEGACY_TEXT" {
                value["type"] = json!("TEXT_MESSAGE_CONTENT");
                value["messageId"] = json!("m");
                value["delta"] = json!("translated");
                value.as_object_mut().unwrap().remove("text");
            }
            Ok(value)
        });
        Box::pin(async move { Ok(boxed_raw_stream(stream::iter(values))) })
    }
}

#[tokio::test]
async fn raw_transport_translates_before_shared_enforcement() {
    let transport = TranslatingRawTransport {
        events: vec![
            json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
            json!({"type":"LEGACY_TEXT","text":"translated"}),
            json!({"type":"FUTURE_EVENT","payload":true}),
            json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
        ],
    };
    let events: Vec<Event> = RemoteAgent::new(transport)
        .run_events(RunParams::new("t", "r"))
        .map(Result::unwrap)
        .collect()
        .await;
    assert_eq!(
        events.iter().map(Event::event_type).collect::<Vec<_>>(),
        [
            EventType::RunStarted,
            EventType::TextMessageContent,
            EventType::RunFinished
        ]
    );
}

#[tokio::test]
async fn typed_replay_uses_the_same_remote_agent_boundary() {
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]);
    let events: Vec<Event> = RemoteAgent::new(transport)
        .run_events(RunParams::new("t", "r"))
        .map(Result::unwrap)
        .collect()
        .await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_type(), EventType::RunStarted);
    assert_eq!(events[1].event_type(), EventType::RunFinished);
}
