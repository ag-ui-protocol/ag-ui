//! AG-UI 1.0 terminal outcomes at the typed and SSE boundaries.

#[cfg(all(feature = "client", feature = "sse"))]
use ag_ui::Event;
use ag_ui::RunOutcome;
use serde_json::json;

#[test]
fn cancelled_outcome_is_distinct_from_success_and_closed_to_extra_fields() {
    let outcome: RunOutcome = serde_json::from_value(json!({"type":"cancelled"})).unwrap();
    assert_eq!(outcome, RunOutcome::Cancelled);
    assert!(outcome.is_cancelled());
    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({"type":"cancelled"})
    );
    assert!(
        serde_json::from_value::<RunOutcome>(json!({
            "type":"cancelled", "interrupts":[]
        }))
        .is_err()
    );
}

#[test]
fn success_preserves_frontend_tool_ids_without_changing_legacy_success() {
    let plain: RunOutcome = serde_json::from_value(json!({"type":"success"})).unwrap();
    assert_eq!(plain, RunOutcome::Success);
    assert_eq!(
        serde_json::to_value(plain).unwrap(),
        json!({"type":"success"})
    );

    let declared = json!({
        "type":"success", "pendingToolCallIds":["call-1", "call-2"]
    });
    let outcome: RunOutcome = serde_json::from_value(declared.clone()).unwrap();
    assert_eq!(serde_json::to_value(&outcome).unwrap(), declared);
    assert_eq!(
        outcome
            .pending_tool_call_ids()
            .iter()
            .map(|id| id.as_str())
            .collect::<Vec<_>>(),
        ["call-1", "call-2"]
    );
    assert_eq!(
        outcome,
        RunOutcome::success_with_pending_tool_calls(["call-1", "call-2"])
    );
    assert!(
        serde_json::from_value::<RunOutcome>(json!({
            "type":"success", "pendingToolCallIds":null
        }))
        .is_err()
    );
}

#[cfg(all(feature = "client", feature = "sse"))]
#[tokio::test]
async fn normative_cancelled_stream_delivers_prior_work_and_its_terminal() {
    use ag_ui::client::transport::decode_events;
    use futures_util::{StreamExt, stream};

    let wire = [
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r","protocolVersion":"1.0"}),
        json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}),
        json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"delivered before the stop"}),
        json!({"type":"TEXT_MESSAGE_END","messageId":"m"}),
        json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"cancelled"}}),
    ];
    let body = wire
        .iter()
        .map(|value| ag_ui::encode::sse::frame(&value.to_string()))
        .collect::<String>();
    let events: Vec<Event> =
        decode_events(stream::iter([Ok::<_, std::io::Error>(body.into_bytes())]))
            .map(Result::unwrap)
            .collect()
            .await;
    assert!(matches!(
        &events[2],
        Event::TextMessageContent(content) if content.delta == "delivered before the stop"
    ));
    assert!(matches!(
        events.last(),
        Some(Event::RunFinished(finished)) if finished.outcome == Some(RunOutcome::Cancelled)
    ));
}
