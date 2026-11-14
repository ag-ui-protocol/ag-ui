#[path = "support/http.rs"]
mod http;
use http::{Request, TEST_TIMEOUT};
mod lifecycle_support;
use ag_ui_client::{
    Agent, HttpAgent, RunTerminalStatus,
    core::{event::Event, processing::normalize_run_input, types::RunAgentInput},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, net::TcpListener, task::JoinHandle};

async fn host(script: Vec<Value>) -> (HttpAgent, JoinHandle<Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        tokio::time::timeout(TEST_TIMEOUT, async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = http::read(&mut socket).await.expect("complete actual HTTP request");
            // Exercise the public pre-admission producer boundary before emitting
            // headers, then the public live producer encoder for every event.
            let normalized = normalize_run_input(serde_json::from_slice(&request.body).unwrap()).unwrap();
            assert_eq!(normalized.input.thread_id.as_ref(), "thread");
            let mut body = ag_ui_encoder::keepalive("fixture heartbeat").unwrap();
            for value in script {
                body.extend(
                    ag_ui_encoder::encode_live(&serde_json::from_value::<Event>(value).unwrap())
                        .unwrap(),
                );
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                ag_ui_encoder::CONTENT_TYPE,
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            socket.shutdown().await.unwrap();
            request
        }).await.expect("fixture server timed out")
    });
    let agent = HttpAgent::builder()
        .with_url_str(&format!("http://{address}/run"))
        .unwrap()
        .build()
        .unwrap();
    (agent, task)
}

#[tokio::test]
async fn second_turn_uses_only_public_full_history_and_actual_wire_preserves_replacements_and_deletions()
 {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let initial = vec![
            message(json!({"id":"replace","role":"assistant","content":"old"})),
            message(json!({"id":"drop","role":"user","content":"obsolete"})),
            message(
                json!({"id":"client-ui","role":"activity","activityType":"local","content":{"n":null}}),
            ),
        ];
        let replacement = json!({"id":"replace","role":"developer","content":"new","metadata":{"nested":{"null":null}}});
        let media = json!({"id":"media","role":"user","content":[{"type":"text","text":"hello"},{"type":"document","source":{"type":"url","value":"https://example.com/file.pdf","mimeType":"application/pdf"}}]});
        let first_script = vec![
            start("first"),
            json!({"type":"MESSAGES_SNAPSHOT","messages":[media.clone(),replacement.clone()]}),
            json!({"type":"STATE_SNAPSHOT","snapshot":{"nested":null,"list":[1,null]}}),
            finish("first"),
        ];
        let (agent, first_request) = host(first_script).await;
        let mut first = input("first");
        first.messages = initial;
        let first_result = agent.run_input(&first, ()).await.unwrap();
        assert_eq!(
            values(&first_result.messages),
            vec![
                replacement.clone(),
                json!({"id":"client-ui","role":"activity","activityType":"local","content":{"n":null}}),
                media.clone()
            ]
        );
        assert_eq!(first_result.new_messages.len(), 1);
        let captured = first_request.await.unwrap();
        assert_eq!(captured.headers["accept"], "text/event-stream");
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["messages"].as_array().unwrap().len(), 2);
        drop(agent);
        // Recreate both the client and fixture producer; no hidden handler state or
        // subscriber capture survives the first request.
        let (agent, second_request) = host(vec![start("second"), finish("second")]).await;
        let second = RunAgentInput::new(
            "thread",
            "second",
            first_result.new_state,
            first_result.messages,
            vec![],
            vec![],
            json!({"keep":null}),
        );
        let second_result = agent.run_input(&second, ()).await.unwrap();
        let captured = second_request.await.unwrap();
        // Independent wire expectation: do not derive the oracle through the
        // same preparation implementation used by the HTTP client.
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap(), json!({
            "threadId":"thread", "runId":"second", "protocolVersion":"1.0",
            "state":{"nested":null,"list":[1,null]},
            "messages":[replacement.clone(), media.clone()],
            "tools":[], "context":[], "forwardedProps":{"keep":null}
        }));
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["messages"], json!([replacement, media]));
        assert_eq!(
            serde_json::from_slice::<Value>(&captured.body).unwrap()["state"],
            json!({"nested":null,"list":[1,null]})
        );
        assert_eq!(second_result.messages.len(), 3);
        assert!(
            matches!(second_result.terminal_status,RunTerminalStatus::Finished{run_id,..} if run_id.as_ref()=="second")
        );
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn multiple_frontend_results_and_interrupt_resume_reach_exact_request() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let mut request = input("resume");
        request.parent_run_id = Some("paused".into());
        request.context =
            Some(serde_json::from_value(json!([{"description":"locale","value":"en-GB"}])).unwrap());
        request.forwarded_props = json!({"config":{"keep":null},"scalar":7});
        request.state = json!([null,{"n":2}]);
        request.resume=Some(serde_json::from_value(json!([{"interruptId":"approval","status":"resolved","payload":{"approved":false},"metadata":{"note":null}}])).unwrap());
        request.messages = vec![
            message(
                json!({"id":"calls","role":"assistant","toolCalls":[{"id":"first-call","type":"function","function":{"name":"lookup","arguments":"{}"}},{"id":"second-call","type":"function","function":{"name":"calculate","arguments":"{}"}}]}),
            ),
            message(
                json!({"id":"first-result","role":"tool","toolCallId":"first-call","content":[{"type":"text","text":"done"}],"metadata":{"keep":null}}),
            ),
            message(
                json!({"id":"second-result","role":"tool","toolCallId":"second-call","content":"failed: denied","error":"DENIED"}),
            ),
        ];
        let (agent, captured)=host(vec![start("resume"),json!({"type":"RUN_FINISHED","threadId":"thread","runId":"resume","outcome":{"type":"interrupt","interrupts":[{"id":"next","reason":"review"}]}})]).await;
        let result = agent.run_input(&request, ()).await.unwrap();
        assert!(matches!(
            result.outcome,
            Some(ag_ui_client::core::types::RunFinishedOutcome::Interrupt { .. })
        ));
        let captured = captured.await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap(), json!({
            "threadId":"thread", "runId":"resume", "parentRunId":"paused", "protocolVersion":"1.0",
            "state":[null,{"n":2}], "tools":[],
            "context":[{"description":"locale","value":"en-GB"}],
            "forwardedProps":{"config":{"keep":null},"scalar":7},
            "resume":[{"interruptId":"approval","status":"resolved","payload":{"approved":false},"metadata":{"note":null}}],
            "messages":[
                {"id":"calls","role":"assistant","toolCalls":[{"id":"first-call","type":"function","function":{"name":"lookup","arguments":"{}"}},{"id":"second-call","type":"function","function":{"name":"calculate","arguments":"{}"}}]},
                {"id":"first-result","role":"tool","toolCallId":"first-call","content":[{"type":"text","text":"done"}],"metadata":{"keep":null}},
                {"id":"second-result","role":"tool","toolCallId":"second-call","content":"failed: denied","error":"DENIED"}
            ]
        }));
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["parentRunId"], "paused");
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["messages"][2]["error"], "DENIED");
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["resume"][0]["payload"]["approved"], false);
        assert_eq!(serde_json::from_slice::<Value>(&captured.body).unwrap()["state"], json!([null,{"n":2}]));
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn null_state_cross_run_omits_wire_state_then_producer_restores_canonical_null() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let (agent, captured) = host(vec![
            start("one"),
            json!({"type":"STATE_SNAPSHOT","snapshot":null}),
            finish("one"),
        ])
        .await;
        let first = agent.run_input(&input("one"), ()).await.unwrap();
        captured.await.unwrap();
        assert!(first.new_state.is_null());
        drop(agent);
        let (agent, captured) = host(vec![
            start("two"),
            json!({"type":"STATE_SNAPSHOT","snapshot":null}),
            json!({"type":"STATE_DELTA","delta":[{"op":"replace","path":"","value":[null,7]}]}),
            finish("two"),
        ])
        .await;
        let second = RunAgentInput::new(
            "thread",
            "two",
            first.new_state,
            first.messages,
            vec![],
            vec![],
            Value::Null,
        );
        let result = agent.run_input(&second, ()).await.unwrap();
        let captured = captured.await.unwrap();
        assert!(
            serde_json::from_slice::<Value>(&captured.body)
                .unwrap()
                .get("state")
                .is_none()
        );
        assert!(
            serde_json::from_slice::<Value>(&captured.body)
                .unwrap()
                .get("forwardedProps")
                .is_none()
        );
        assert_eq!(
            normalize_run_input(serde_json::from_slice::<Value>(&captured.body).unwrap())
                .unwrap()
                .effective_state,
            json!({})
        );
        assert_eq!(result.new_state, json!([null, 7]));
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn typed_application_baseline_rejection_is_explicit_and_sanitized() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let agent = HttpAgent::builder()
            .with_url_str("http://127.0.0.1:9/")
            .unwrap()
            .build()
            .unwrap();
        let request = RunAgentInput::new("thread", "typed", (), vec![], vec![], vec![], json!({}));
        let error = agent.run_input(&request, ()).await.unwrap_err();
        assert!(matches!(
            error,
            ag_ui_client::agent::AgentError::Config { .. }
        ));
        assert_eq!(
            error.to_string(),
            "Invalid configuration: Application state cannot represent the effective input baseline"
        );
    })
    .await
    .expect("fixture client or server join timed out");
}
