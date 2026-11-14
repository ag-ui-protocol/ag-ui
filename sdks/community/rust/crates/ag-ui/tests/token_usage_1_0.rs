//! Every known usage field must survive the raw transport and SSE boundaries.
#![cfg(all(feature = "client", feature = "sse"))]

use ag_ui::client::RemoteAgent;
use ag_ui::client::transport::{
    RawTransportFuture, Transport, TransportFuture, boxed_raw_stream, decode_events,
};
use ag_ui::{Event, RunAgentInput};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

#[derive(Clone)]
struct RawTransport(Value);

impl Transport for RawTransport {
    fn run(&self, _: RunAgentInput) -> TransportFuture {
        panic!("the shared boundary must request raw JSON")
    }

    fn run_raw(&self, _: RunAgentInput) -> RawTransportFuture {
        let event = self.0.clone();
        Box::pin(async move { Ok(boxed_raw_stream(stream::once(async { Ok(event) }))) })
    }
}

async fn decoded_by_both_transports(value: &Value) -> Vec<ag_ui::client::Result<Event>> {
    let raw = RemoteAgent::new(RawTransport(value.clone()))
        .run_events(RunAgentInput::new("t", "r"))
        .collect::<Vec<_>>()
        .await;
    let body = ag_ui::encode::sse::frame(&value.to_string());
    let sse = decode_events(stream::iter([Ok::<_, std::io::Error>(body.into_bytes())]))
        .collect::<Vec<_>>()
        .await;
    assert_eq!(raw.len(), 1);
    assert_eq!(sse.len(), 1);
    raw.into_iter().chain(sse).collect()
}

#[tokio::test]
async fn every_schema_usage_field_survives_success_and_error_events() {
    let schema: Value =
        serde_json::from_str(include_str!("../src/protocol/schema-1.0.json")).unwrap();
    let usage = schema["$defs"]["TokenUsage"]["properties"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, field)| {
            let value = match field["type"].as_str().unwrap() {
                "string" => json!(name),
                "integer" => json!(42),
                other => panic!("add a representative TokenUsage value for {name}: {other}"),
            };
            (name.clone(), value)
        })
        .collect::<serde_json::Map<_, _>>();
    for value in [
        json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[usage.clone()]}),
        json!({"type":"RUN_ERROR","message":"failed","usage":[usage.clone()]}),
    ] {
        for event in decoded_by_both_transports(&value).await {
            assert_eq!(serde_json::to_value(event.unwrap()).unwrap(), value);
        }
    }
}

#[tokio::test]
async fn malformed_cache_write_counts_fail_on_both_transports() {
    for count in [
        json!(-1),
        json!(1.5),
        json!(null),
        json!(9007199254740992_u64),
    ] {
        let value = json!({
            "type":"RUN_FINISHED", "threadId":"t", "runId":"r",
            "usage":[{"cacheWriteInputTokens":count}]
        });
        for result in decoded_by_both_transports(&value).await {
            let error = result.unwrap_err().to_string();
            assert!(error.contains("/usage/0/cacheWriteInputTokens"), "{error}");
        }
    }
}

#[tokio::test]
async fn integral_json_numbers_survive_without_accepting_fractional_or_string_values() {
    for numeric in ["1.0", "1e3", "-0.0", "9007199254740991.0"] {
        let value: Value = serde_json::from_str(&format!(
            r#"{{"type":"RUN_FINISHED","threadId":"t","runId":"r","timestamp":{numeric},"usage":[{{"inputTokens":{numeric}}}]}}"#
        ))
        .unwrap();
        for event in decoded_by_both_transports(&value).await {
            let event = serde_json::to_value(event.unwrap()).unwrap();
            assert_eq!(event["timestamp"].as_f64(), value["timestamp"].as_f64());
            assert_eq!(
                event["usage"][0]["inputTokens"].as_f64(),
                value["usage"][0]["inputTokens"].as_f64()
            );
            assert!(event["timestamp"].is_i64());
            assert!(event["usage"][0]["inputTokens"].is_u64());
        }
    }
    for numeric in ["-1.0", "-9007199254740991.0"] {
        let value: Value = serde_json::from_str(&format!(
            r#"{{"type":"RUN_STARTED","threadId":"t","runId":"r","timestamp":{numeric}}}"#
        ))
        .unwrap();
        for event in decoded_by_both_transports(&value).await {
            let event = serde_json::to_value(event.unwrap()).unwrap();
            assert_eq!(event["timestamp"].as_f64(), value["timestamp"].as_f64());
            assert!(event["timestamp"].is_i64());
        }
    }
    for numeric in ["1.5", "\"1\"", "9007199254740992.0", "-9007199254740992.0"] {
        let value: Value = serde_json::from_str(&format!(
            r#"{{"type":"RUN_STARTED","threadId":"t","runId":"r","timestamp":{numeric}}}"#
        ))
        .unwrap();
        for event in decoded_by_both_transports(&value).await {
            assert!(event.unwrap_err().to_string().contains("/timestamp"));
        }
    }
}
