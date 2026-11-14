mod lifecycle_support;
use ag_ui_client::{
    Agent, RunTerminalStatus,
    agent::{AgentError, AgentStateMutation},
    core::event::Event,
    subscriber::{AgentSubscriber, AgentSubscriberParams, Subscribers},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn subscriber_free_results_describe_only_latest_terminal() {
    let producer_error = || json!({"type":"RUN_ERROR","message":"backend failed","code":"UPSTREAM","usage":[{"inputTokens":7}]});
    for script in [
        vec![producer_error()],
        vec![
            start("requested"),
            json!({"type":"RUN_FINISHED","threadId":"thread","runId":"requested","result":{"stale":true},"outcome":{"type":"success"}}),
            producer_error(),
        ],
        vec![
            start("earlier"),
            finish("earlier"),
            start("requested"),
            producer_error(),
        ],
    ] {
        let result = run(script).await.unwrap();
        let RunTerminalStatus::ProducerError(error) = result.terminal_status else {
            panic!("must preserve producer error")
        };
        assert_eq!(error.message, "backend failed");
        assert_eq!(error.code.as_deref(), Some("UPSTREAM"));
        assert_eq!(result.usage.unwrap()[0].input_tokens, Some(7));
        assert_eq!(result.result, None);
        assert!(result.result.is_none());
        assert!(result.outcome.is_none());
    }
    let result = run(vec![
        producer_error(),
        start("requested"),
        finish("requested"),
    ])
    .await
    .unwrap();
    assert!(
        matches!(result.terminal_status, RunTerminalStatus::Finished { run_id, .. } if run_id.as_ref() == "requested")
    );
    assert!(result.usage.is_none());
    assert!(result.result.is_none());
}

#[tokio::test]
async fn run_ids_need_not_match_request_or_each_other_like_typescript() {
    let result = run(vec![
        start("historical"),
        finish("historical"),
        start("requested"),
        finish("requested"),
    ])
    .await
    .unwrap();
    assert!(matches!(
        result.terminal_status,
        RunTerminalStatus::Finished { .. }
    ));
    for values in [
        vec![start("historical"), finish("historical")],
        vec![
            start("requested"),
            finish("requested"),
            start("other"),
            finish("other"),
        ],
        vec![start("requested"), finish("different")],
        vec![
            json!({"type":"RUN_STARTED","threadId":"foreign","runId":"requested"}),
            finish("requested"),
        ],
        vec![
            start("requested"),
            json!({"type":"RUN_FINISHED","threadId":"foreign","runId":"requested"}),
        ],
    ] {
        assert!(matches!(
            run(values).await.unwrap().terminal_status,
            RunTerminalStatus::Finished { .. }
        ));
    }
}

#[tokio::test]
async fn eof_checks_the_latest_segment_and_terminal_sequence() {
    for values in [
        vec![],
        vec![start("requested")],
        vec![
            start("historical"),
            finish("historical"),
            start("requested"),
        ],
        vec![
            json!({"type":"RUN_ERROR","message":"past"}),
            start("requested"),
        ],
    ] {
        assert!(matches!(
            run(values).await,
            Err(AgentError::IncompleteRun(_))
        ));
    }
    for values in [
        vec![start("requested"), start("requested")],
        vec![
            json!({"type":"RUN_ERROR","message":"first"}),
            json!({"type":"RUN_ERROR","message":"again"}),
        ],
        vec![
            start("requested"),
            finish("requested"),
            json!({"type":"RAW","event":{}}),
        ],
    ] {
        assert!(matches!(
            run(values).await,
            Err(AgentError::Execution { .. })
        ));
    }
}

#[derive(Default)]
struct Counts {
    initialized: usize,
    finalized: usize,
    failed: usize,
    events: usize,
    messages: usize,
    calls: usize,
}
struct Observer {
    counts: Arc<Mutex<Counts>>,
    fail: &'static str,
}
#[async_trait::async_trait]
impl AgentSubscriber for Observer {
    async fn on_run_initialized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.counts.lock().unwrap().initialized += 1;
        if self.fail == "initialize" {
            return Err(AgentError::exec("initialize failure"));
        }
        Ok(AgentStateMutation::default())
    }
    async fn on_event(
        &self,
        _: &Event,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.counts.lock().unwrap().events += 1;
        if self.fail == "event" {
            return Err(AgentError::exec("event failure"));
        }
        Ok(AgentStateMutation::default())
    }
    async fn on_messages_changed(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        if self.fail == "mutation" {
            return Err(AgentError::exec("mutation failure"));
        }
        Ok(())
    }
    async fn on_new_message(
        &self,
        _: &ag_ui_client::core::types::Message,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.counts.lock().unwrap().messages += 1;
        Ok(())
    }
    async fn on_new_tool_call(
        &self,
        _: &ag_ui_client::core::types::ToolCall,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.counts.lock().unwrap().calls += 1;
        Ok(())
    }
    async fn on_run_finalized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.counts.lock().unwrap().finalized += 1;
        if self.fail == "finalize" {
            return Err(AgentError::exec("finalize failure"));
        }
        Ok(AgentStateMutation::default())
    }
    async fn on_run_failed(
        &self,
        _: &AgentError,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.counts.lock().unwrap().failed += 1;
        if self.fail == "failed" {
            return Err(AgentError::exec("failed callback failure"));
        }
        Ok(AgentStateMutation::default())
    }
}

#[tokio::test]
async fn every_subscriber_finalizes_exactly_once_on_all_callback_failure_paths() {
    for fail in ["", "initialize", "event", "mutation", "finalize", "failed"] {
        let first = Arc::new(Mutex::new(Counts::default()));
        let second = Arc::new(Mutex::new(Counts::default()));
        let subscribers = Subscribers::new(vec![
            Arc::new(Observer {
                counts: first.clone(),
                fail,
            }),
            Arc::new(Observer {
                counts: second.clone(),
                fail: "",
            }),
        ]);
        let mut script = vec![
            start("requested"),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m","delta":"hello"}),
        ];
        if fail != "failed" {
            script.push(finish("requested"));
        }
        let result = Script(script)
            .run_input(&input("requested"), subscribers)
            .await;
        assert_eq!(result.is_ok(), fail.is_empty(), "{fail}");
        for counts in [&first, &second] {
            let counts = counts.lock().unwrap();
            assert_eq!(counts.finalized, 1, "{fail}");
            assert_eq!(counts.failed, usize::from(!fail.is_empty()), "{fail}");
        }
        if fail.is_empty() {
            assert_eq!(first.lock().unwrap().messages, 1);
        }
    }
}

#[tokio::test]
async fn producer_errors_are_not_subscriber_failure_callbacks() {
    let counts = Arc::new(Mutex::new(Counts::default()));
    let result = Script(vec![json!({"type":"RUN_ERROR","message":"upstream"})])
        .run_input(
            &input("requested"),
            (Observer {
                counts: counts.clone(),
                fail: "",
            },),
        )
        .await
        .unwrap();
    assert!(matches!(
        result.terminal_status,
        RunTerminalStatus::ProducerError(_)
    ));
    let counts = counts.lock().unwrap();
    assert_eq!(
        (counts.initialized, counts.finalized, counts.failed),
        (1, 1, 0)
    );
}

#[tokio::test]
async fn nested_parallel_invocations_and_inherited_call_ownership_are_preserved() {
    let result = run(vec![start("requested"),
        json!({"type":"SUBAGENT_STARTED","subagentRunId":"parent","name":"worker"}),
        json!({"type":"SUBAGENT_STARTED","subagentRunId":"child","name":"worker","parentSubagentRunId":"parent","parentMessageId":"link","parentToolCallId":"call"}),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"p","role":"assistant","subagentRunId":"parent","delta":"p"}),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"c","role":"user","subagentRunId":"child","delta":"c"}),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"parent"}),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"c","delta":"2"}),
        json!({"type":"SUBAGENT_STARTED","subagentRunId":"late","name":"worker","parentSubagentRunId":"parent"}),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"late"}),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"child"}),
        json!({"type":"TOOL_CALL_START","toolCallId":"tc","toolCallName":"f","parentMessageId":"p"}),
        json!({"type":"TOOL_CALL_ARGS","toolCallId":"tc","delta":"{}","subagentRunId":"parent"}),
        json!({"type":"TOOL_CALL_END","toolCallId":"tc"}), finish("requested")]).await.unwrap();
    let messages = values(&result.messages);
    assert_eq!(messages[0]["subagentRunId"], "parent");
    assert_eq!(messages[0]["toolCalls"][0]["function"]["arguments"], "{}");
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["subagentRunId"], "child");
    assert_eq!(messages[1]["content"], "c2");
}

#[tokio::test]
async fn invocation_ids_cannot_duplicate_reopen_or_name_unannounced_parents() {
    let announce = || json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"});
    for middle in [
        vec![announce(), announce()],
        vec![
            announce(),
            json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
            announce(),
        ],
        vec![
            json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker","parentSubagentRunId":"missing"}),
        ],
        vec![
            json!({"type":"REASONING_START","messageId":"span"}),
            json!({"type":"REASONING_START","messageId":"span"}),
        ],
    ] {
        let mut script = vec![start("requested")];
        script.extend(middle);
        script.push(finish("requested"));
        assert!(matches!(
            run(script).await,
            Err(AgentError::Execution { .. })
        ));
    }
    assert!(
        run(vec![
            start("old"),
            announce(),
            json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
            finish("old"),
            start("requested"),
            announce(),
            json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
            finish("requested")
        ])
        .await
        .is_ok()
    );
}

struct BrokenTransport {
    fail_open: bool,
}
#[async_trait::async_trait]
impl Agent for BrokenTransport {
    async fn run(
        &self,
        _: &ag_ui_client::core::types::RunAgentInput,
    ) -> Result<futures::stream::BoxStream<'async_trait, Result<Event, AgentError>>, AgentError>
    {
        if self.fail_open {
            return Err(AgentError::exec("connection failed before stream"));
        }
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(event(start("requested"))),
            Ok(event(finish("requested"))),
            Err(AgentError::exec("truncated trailing transport data")),
        ])))
    }
}
#[tokio::test]
async fn stream_open_and_trailing_transport_errors_fail_and_finalize_once() {
    for fail_open in [false, true] {
        let counts = Arc::new(Mutex::new(Counts::default()));
        let result = BrokenTransport { fail_open }
            .run_input(
                &input("requested"),
                (Observer {
                    counts: counts.clone(),
                    fail: "",
                },),
            )
            .await;
        assert!(result.is_err());
        let counts = counts.lock().unwrap();
        assert_eq!(
            (counts.initialized, counts.failed, counts.finalized),
            (1, 1, 1)
        );
    }
}

#[tokio::test]
async fn completed_and_error_segments_keep_accumulated_thread_state_and_messages() {
    let result = run(vec![
        start("historical"),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"old","delta":"saved"}),
        json!({"type":"STATE_SNAPSHOT","snapshot":{"retained":null}}),
        json!({"type":"RUN_ERROR","message":"past"}),
        start("requested"),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"new","delta":"next"}),
        finish("requested"),
    ])
    .await
    .unwrap();
    assert_eq!(result.new_state, json!({"retained":null}));
    assert_eq!(
        result
            .messages
            .iter()
            .map(|message| message.content().unwrap())
            .collect::<Vec<_>>(),
        vec!["saved", "next"]
    );
    assert!(matches!(
        result.terminal_status,
        RunTerminalStatus::Finished { .. }
    ));
}
