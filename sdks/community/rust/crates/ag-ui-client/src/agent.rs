use futures::stream::StreamExt;
use std::collections::HashSet;

use crate::chunk::ChunkExpander;
use crate::core::JsonValue;
use crate::core::types::{
    AgentId, Context, Message, MessageId, ResumeEntry, RunAgentInput, RunId, ThreadId, Tool,
};
use crate::core::{AgentState, FwdProps};
use crate::event_handler::EventHandler;
use crate::stream::EventStream;
use crate::subscriber::IntoSubscribers;

/// Configuration for an Agent.
#[derive(Debug, Clone)]
pub struct AgentConfig<StateT = JsonValue> {
    pub agent_id: Option<AgentId>,
    pub description: Option<String>,
    pub thread_id: Option<ThreadId>,
    pub initial_messages: Option<Vec<Message>>,
    pub initial_state: Option<StateT>,
    pub debug: Option<bool>,
}

impl<S> Default for AgentConfig<S>
where
    S: Default,
{
    fn default() -> Self {
        Self {
            agent_id: None,
            description: None,
            thread_id: None,
            initial_messages: None,
            initial_state: None,
            debug: None,
        }
    }
}

/// Parameters for running an agent.
#[derive(Debug, Clone, Default)]
pub struct RunAgentParams<StateT: AgentState = JsonValue, FwdPropsT: FwdProps = JsonValue> {
    /// Omit to start a fresh thread; supply this for subsequent turns.
    pub thread_id: Option<ThreadId>,
    pub run_id: Option<RunId>,
    pub parent_run_id: Option<RunId>,
    pub resume: Option<Vec<ResumeEntry>>,
    pub tools: Vec<Tool>,
    pub context: Vec<Context>,
    pub forwarded_props: FwdPropsT,
    pub messages: Vec<Message>,
    pub state: StateT,
}

impl<StateT, FwdPropsT> RunAgentParams<StateT, FwdPropsT>
where
    StateT: AgentState + Default,
    FwdPropsT: FwdProps + Default,
{
    /// Construct a new instance of [RunAgentParams] where the state and forwarded_props are
    /// manually typed.
    ///
    /// If you do not need this level of customization, use [RunAgentParams::new].
    pub fn new_typed() -> Self {
        Self {
            thread_id: None,
            run_id: None,
            parent_run_id: None,
            resume: None,
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: FwdPropsT::default(),
            messages: Vec::new(),
            state: StateT::default(),
        }
    }

    pub fn with_thread_id(mut self, thread_id: ThreadId) -> Self {
        self.thread_id = Some(thread_id);
        self
    }
    pub fn with_parent_run_id(mut self, parent_run_id: RunId) -> Self {
        self.parent_run_id = Some(parent_run_id);
        self
    }
    pub fn with_run_id(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }
    pub fn with_resume(mut self, resume: Vec<ResumeEntry>) -> Self {
        self.resume = Some(resume);
        self
    }
    pub fn add_tool(mut self, tool: Tool) -> Self {
        self.tools.push(tool);
        self
    }
    pub fn add_context(mut self, ctx: Context) -> Self {
        self.context.push(ctx);
        self
    }
    pub fn with_forwarded_props(mut self, props: FwdPropsT) -> Self {
        self.forwarded_props = props;
        self
    }
    pub fn with_state(mut self, state: StateT) -> Self {
        self.state = state;
        self
    }
    pub fn add_message(mut self, msg: Message) -> Self {
        self.messages.push(msg);
        self
    }
    pub fn user(mut self, content: impl Into<String>) -> Self {
        self.messages.push(Message::User {
            id: MessageId::random(),
            content: content.into().into(),
            name: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        });
        self
    }
}

impl RunAgentParams<JsonValue, JsonValue> {
    /// Construct an empty parameter object with JSON Values for state and forwarded props.
    ///
    /// If you want typed state and/or forwarded_props, use [RunAgentParams::new_typed].
    pub fn new() -> Self {
        Self::default()
    }
}

/// The last run segment's producer-reported terminal status.
/// Consumer protocol, transport, and callback failures are returned as `Err` instead.
#[derive(Debug, Clone, PartialEq)]
pub enum RunTerminalStatus {
    Finished { thread_id: ThreadId, run_id: RunId },
    ProducerError(crate::core::event::RunErrorEvent),
}

#[derive(Debug, Clone)]
pub struct RunAgentResult<StateT: AgentState> {
    /// Convenience projection of `output`, using null when output is absent.
    pub result: JsonValue,
    /// The producer's optional output, independently of whether the run succeeded.
    pub output: Option<JsonValue>,
    pub terminal_status: RunTerminalStatus,
    /// Complete reconciled history. Use this collection for the next turn.
    /// Unlike `new_messages`, this preserves replacements and deletions.
    pub messages: Vec<Message>,
    pub outcome: Option<crate::core::types::RunFinishedOutcome>,
    pub usage: Option<Vec<crate::core::types::TokenUsage>>,
    pub new_messages: Vec<Message>,
    pub new_state: StateT,
}

pub type AgentRunState<StateT, FwdPropsT> = RunAgentInput<StateT, FwdPropsT>;

#[derive(Debug, Clone)]
pub struct AgentStateMutation<StateT = JsonValue> {
    pub messages: Option<Vec<Message>>,
    pub state: Option<StateT>,
    pub stop_propagation: bool,
}

impl<StateT> Default for AgentStateMutation<StateT> {
    fn default() -> Self {
        Self {
            messages: None,
            state: None,
            stop_propagation: false,
        }
    }
}

// Error types
pub use crate::error::AgUiClientError as AgentError;

// TODO: Expand documentation
/// Agent trait
#[async_trait::async_trait]
pub trait Agent<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    /// Low-level event stream. This does not apply state, expand chunks, verify
    /// lifecycle completion, or call subscribers. Prefer [`Agent::run_input`].
    async fn run(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<EventStream<'async_trait, StateT>, AgentError>;

    /// Runs an agent, creating a fresh thread unless `params.thread_id` is set.
    /// For complete control over input identity and continuation, use [`Agent::run_input`].
    ///
    /// # Parameters
    /// * `params`: The run parameters as given in [RunAgentParams]
    /// * `subscribers`: A (sequence of) type(s) that implement [crate::subscriber::AgentSubscriber];
    /// can also be a unit type `()` or `None` if none are needed. Valid types are `T`, `(T,)`,
    /// `Vec<T>`, `&[T]`, `()`, `Option<()>` where `T: AgentSubscriber`.
    ///
    /// # Examples
    /// ```no_run
    /// # use ag_ui_client::{Agent, HttpAgent, RunAgentParams, core::types::Message};
    /// # use std::error::Error;
    ///
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn Error>> {
    ///  let agent = HttpAgent::builder()
    ///     .with_url_str("http://127.0.0.1:3000/")?
    ///     .build()?;
    ///
    ///  let message = Message::new_user("Can you give me the current temperature in New York?");
    ///  // Create run parameters
    ///  let params = RunAgentParams::new().add_message(message);
    ///
    ///  // Run the agent without subscriber
    ///  let result = agent.run_agent(&params, ()).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Notes
    /// Currently the subscriber pattern is the only way to subscriber to an Agent run's lifecycle.
    async fn run_agent(
        &self,
        params: &RunAgentParams<StateT, FwdPropsT>,
        subscribers: impl IntoSubscribers<StateT, FwdPropsT>,
    ) -> Result<RunAgentResult<StateT>, AgentError> {
        let input = RunAgentInput {
            thread_id: params.thread_id.clone().unwrap_or_else(ThreadId::random),
            run_id: params.run_id.clone().unwrap_or_else(RunId::random),
            state: params.state.clone(),
            messages: params.messages.clone(),
            tools: Some(params.tools.clone()),
            context: Some(params.context.clone()),
            forwarded_props: params.forwarded_props.clone(),
            protocol_version: Some("1.0".to_owned()),
            parent_run_id: params.parent_run_id.clone(),
            resume: params.resume.clone(),
        };
        self.run_input(&input, subscribers).await
    }

    /// Execute a complete input through chunk expansion, lifecycle verification,
    /// reduction and subscriber callbacks. Supply the returned `messages` and
    /// `new_state` as the next turn's history/state, keeping `thread_id` and choosing
    /// a new `run_id`. Activity remains in the result but HTTP filters it from wire
    /// history. Producer RUN_ERROR is an explicit terminal status, not a consumer error.
    /// Every subscriber is finalized once on normal completion or a returned error,
    /// including when another callback returns an error. Dropping this future closes
    /// the stream, but cancellation or a callback panic cannot await async finalizers.
    async fn run_input(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: impl IntoSubscribers<StateT, FwdPropsT>,
    ) -> Result<RunAgentResult<StateT>, AgentError> {
        let current_message_ids: HashSet<_> =
            input.messages.iter().map(|m| m.id().clone()).collect();
        let mut event_handler = EventHandler::new(
            input.messages.clone(),
            input.state.clone(),
            input,
            subscribers.into_subscribers(),
        );
        // Keep cleanup outside this block: no callback failure may bypass or repeat
        // finalization, including errors opening the stream or applying mutations.
        let execution = async {
            let prepared = crate::core::processing::prepare_run_input(input)?;
            event_handler.state =
                serde_json::from_value(prepared.effective_state).map_err(|_| {
                    AgentError::config(
                        "Application state cannot represent the effective input baseline",
                    )
                })?;
            let initialized_state = event_handler.on_initialize().await?;
            let mut outgoing = input.clone();
            outgoing.messages = event_handler.messages.clone();
            crate::core::history::keep_tool_results_with_calls(&mut outgoing.messages);
            // Preserve omitted input state unless initialization explicitly
            // replaces it; the reducer's effective baseline may be {}.
            if initialized_state {
                outgoing.state = event_handler.state.clone();
            }
            let mut stream = self.run(&outgoing).await?.fuse();
            let mut chunks = ChunkExpander::default();
            let mut compatibility = crate::core::compatibility::CompatibilityBoundary::default();
            while let Some(event) = stream.next().await {
                let wire = serde_json::to_value(event?)?;
                let processed = compatibility.normalize_event::<StateT>(wire)?;
                for diagnostic in processed.diagnostics {
                    event_handler.emit_diagnostic(diagnostic).await?;
                }
                let Some(event) = processed.event else {
                    continue;
                };
                for expanded in chunks.expand(event, &event_handler.messages)? {
                    let mutation = event_handler.handle_event(&expanded).await?;
                    event_handler.apply_mutation(mutation).await?;
                }
            }
            event_handler.check_completion()
        }
        .await;
        if let Err(error) = &execution {
            // The original failure is authoritative, but all failure/finalization
            // callbacks still run even if an individual subscriber also fails.
            let _ = event_handler.on_error(error).await;
        }
        let finalized = event_handler.on_finalize().await;
        execution?;
        if let Err(error) = finalized {
            let _ = event_handler.on_error(&error).await;
            return Err(error);
        }
        let new_messages = event_handler
            .messages
            .iter()
            .filter(|m| !current_message_ids.contains(m.id()))
            .cloned()
            .collect();
        Ok(RunAgentResult {
            result: event_handler.output.clone().unwrap_or(JsonValue::Null),
            terminal_status: event_handler
                .terminal_status()
                .expect("completion checked terminal status")
                .clone(),
            output: event_handler.output,
            outcome: event_handler.outcome,
            usage: event_handler.usage,
            new_messages,
            messages: event_handler.messages,
            new_state: event_handler.state,
        })
    }

    fn agent_id(&self) -> Option<&AgentId> {
        None
    }
}

#[cfg(test)]
mod result_tests {
    use super::*;
    use crate::core::event::Event;
    use crate::core::types::RunFinishedOutcome;
    use futures::stream;
    use serde_json::json;

    struct OfflineAgent;
    #[async_trait::async_trait]
    impl Agent for OfflineAgent {
        async fn run(
            &self,
            _input: &RunAgentInput<JsonValue, JsonValue>,
        ) -> Result<EventStream<'async_trait, JsonValue>, AgentError> {
            let values = [
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}),
                json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"done"}),
                json!({"type":"TEXT_MESSAGE_END","messageId":"m"}),
                json!({"type":"STATE_SNAPSHOT","snapshot":{"done":true}}),
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","result":{"ok":true},"outcome":{"type":"success"},"usage":[{"inputTokens":3,"outputTokens":1}]}),
            ];
            let events: Vec<_> = values
                .into_iter()
                .map(|v| Ok(serde_json::from_value::<Event>(v).unwrap()))
                .collect();
            Ok(Box::pin(stream::iter(events)))
        }
    }

    struct ScriptedAgent(Vec<serde_json::Value>);
    #[async_trait::async_trait]
    impl Agent for ScriptedAgent {
        async fn run(
            &self,
            _input: &RunAgentInput<JsonValue, JsonValue>,
        ) -> Result<EventStream<'async_trait, JsonValue>, AgentError> {
            let events: Vec<_> = self
                .0
                .iter()
                .cloned()
                .map(|value| Ok(serde_json::from_value::<Event>(value).unwrap()))
                .collect();
            Ok(Box::pin(stream::iter(events)))
        }
    }
    #[derive(Default)]
    struct Observations {
        args: Vec<(String, String, String)>,
        failed: usize,
        finalized: usize,
    }
    struct Observer(std::sync::Arc<std::sync::Mutex<Observations>>);
    #[async_trait::async_trait]
    impl crate::subscriber::AgentSubscriber for Observer {
        async fn on_tool_call_args_event(
            &self,
            event: &crate::core::event::ToolCallArgsEvent,
            buffer: &str,
            name: &str,
            _args: &std::collections::HashMap<String, JsonValue>,
            _params: crate::subscriber::AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().args.push((
                event.tool_call_id.to_string(),
                buffer.to_owned(),
                name.to_owned(),
            ));
            Ok(AgentStateMutation::default())
        }
        async fn on_run_failed(
            &self,
            _error: &AgentError,
            _params: crate::subscriber::AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().failed += 1;
            Ok(AgentStateMutation::default())
        }
        async fn on_run_finalized(
            &self,
            _params: crate::subscriber::AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().finalized += 1;
            Ok(AgentStateMutation::default())
        }
    }

    #[tokio::test]
    async fn interleaved_owner_lanes_and_tool_callbacks_follow_ids() {
        let script = ScriptedAgent(vec![
            json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"A"}),
            json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","delta":"B","subagentRunId":"s"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"C"}),
            json!({"type":"REASONING_MESSAGE_CHUNK","messageId":"r1","delta":"a"}),
            json!({"type":"REASONING_MESSAGE_CHUNK","messageId":"r2","delta":"b","subagentRunId":"s"}),
            json!({"type":"REASONING_MESSAGE_CHUNK","messageId":"r1","delta":"c"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"tc1","toolCallName":"first","parentMessageId":"m1","delta":"{"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"tc2","toolCallName":"second","parentMessageId":"m2","delta":"{}","subagentRunId":"s"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"tc1","delta":"}"}),
            json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
            json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
        ]);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Observations::default()));
        let result = script
            .run_agent(
                &RunAgentParams::new()
                    .with_thread_id("t".into())
                    .with_run_id("r".into()),
                (Observer(seen.clone()),),
            )
            .await
            .unwrap();
        let messages: Vec<_> = result
            .new_messages
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        assert_eq!(messages[0]["content"], "AC");
        assert_eq!(messages[1]["content"], "B");
        assert_eq!(messages[2]["content"], "ac");
        assert_eq!(messages[3]["content"], "b");
        assert_eq!(messages[0]["toolCalls"][0]["function"]["arguments"], "{}");
        assert_eq!(messages[1]["toolCalls"][0]["function"]["arguments"], "{}");
        assert_eq!(
            seen.lock().unwrap().args,
            [
                ("tc1".into(), "{".into(), "first".into()),
                ("tc2".into(), "{}".into(), "second".into()),
                ("tc1".into(), "{}".into(), "first".into()),
            ]
        );
    }

    #[tokio::test]
    async fn same_name_steps_are_independent_per_owner() {
        for subagent_closes_first in [true, false] {
            let mut values = vec![
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"STEP_STARTED","stepName":"search"}),
                json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
                json!({"type":"STEP_STARTED","stepName":"search","subagentRunId":"s"}),
            ];
            let parent_end = json!({"type":"STEP_FINISHED","stepName":"search"});
            let subagent_end =
                json!({"type":"STEP_FINISHED","stepName":"search","subagentRunId":"s"});
            if subagent_closes_first {
                values.extend([subagent_end, parent_end]);
            } else {
                values.extend([parent_end, subagent_end]);
            }
            values.extend([
                json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
            ]);
            assert!(
                ScriptedAgent(values)
                    .run_agent(
                        &RunAgentParams::new()
                            .with_thread_id("t".into())
                            .with_run_id("r".into()),
                        ()
                    )
                    .await
                    .is_ok()
            );
        }
        for values in [
            vec![
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"STEP_STARTED","stepName":"search"}),
                json!({"type":"STEP_STARTED","stepName":"search"}),
            ],
            vec![
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
                json!({"type":"STEP_STARTED","stepName":"search","subagentRunId":"s"}),
                json!({"type":"STEP_FINISHED","stepName":"search"}),
            ],
        ] {
            assert!(
                ScriptedAgent(values)
                    .run_agent(
                        &RunAgentParams::new()
                            .with_thread_id("t".into())
                            .with_run_id("r".into()),
                        ()
                    )
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn tool_call_owner_must_match_its_parent_message() {
        for tool_owner in [None, Some("other"), Some("s")] {
            let mut values = vec![
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
                json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant","subagentRunId":"s"}),
                json!({"type":"TEXT_MESSAGE_END","messageId":"m","subagentRunId":"s"}),
            ];
            let mut tool_start = json!({"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"search","parentMessageId":"m"});
            if let Some(owner) = tool_owner {
                tool_start["subagentRunId"] = json!(owner);
            }
            values.push(tool_start);
            values.extend([
                json!({"type":"TOOL_CALL_END","toolCallId":"c","subagentRunId":"s"}),
                json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
            ]);
            let result = ScriptedAgent(values)
                .run_agent(
                    &RunAgentParams::new()
                        .with_thread_id("t".into())
                        .with_run_id("r".into()),
                    (),
                )
                .await;
            assert_eq!(
                result.is_ok(),
                tool_owner != Some("other"),
                "tool owner {tool_owner:?}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn second_run_error_after_run_error_is_rejected() {
        let values = vec![
            json!({"type":"RUN_ERROR","message":"first"}),
            json!({"type":"RUN_ERROR","message":"second"}),
        ];
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Observations::default()));
        assert!(
            ScriptedAgent(values)
                .run_agent(
                    &RunAgentParams::new()
                        .with_thread_id("t".into())
                        .with_run_id("r".into()),
                    (Observer(seen.clone()),)
                )
                .await
                .is_err()
        );
        let seen = seen.lock().unwrap();
        assert_eq!((seen.failed, seen.finalized), (1, 1));
    }

    #[tokio::test]
    async fn run_error_first_and_late_run_error_remain_delivered_streams() {
        for values in [
            vec![json!({"type":"RUN_ERROR","message":"offline"})],
            vec![
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r1"}),
                json!({"type":"RUN_ERROR","message":"first failed"}),
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r2"}),
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r2"}),
                json!({"type":"RUN_ERROR","message":"late transport failure"}),
            ],
        ] {
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Observations::default()));
            assert!(
                ScriptedAgent(values)
                    .run_agent(
                        &RunAgentParams::new()
                            .with_thread_id("t".into())
                            .with_run_id("r".into()),
                        (Observer(seen.clone()),)
                    )
                    .await
                    .is_ok()
            );
            let seen = seen.lock().unwrap();
            assert_eq!(seen.failed, 0);
            assert_eq!(seen.finalized, 1);
        }
    }

    #[tokio::test]
    async fn truncated_and_invalid_opening_streams_fail_and_finalize() {
        for values in [
            vec![json!({"type":"RUN_STARTED","threadId":"t","runId":"r"})],
            vec![json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"})],
            vec![json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"})],
        ] {
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Observations::default()));
            assert!(
                ScriptedAgent(values)
                    .run_agent(
                        &RunAgentParams::new()
                            .with_thread_id("t".into())
                            .with_run_id("r".into()),
                        (Observer(seen.clone()),)
                    )
                    .await
                    .is_err()
            );
            let seen = seen.lock().unwrap();
            assert_eq!(seen.failed, 1);
            assert_eq!(seen.finalized, 1);
        }
    }

    struct CaptureAgent(std::sync::Arc<std::sync::Mutex<Option<JsonValue>>>);
    #[async_trait::async_trait]
    impl Agent for CaptureAgent {
        async fn run(
            &self,
            input: &RunAgentInput<JsonValue, JsonValue>,
        ) -> Result<EventStream<'async_trait, JsonValue>, AgentError> {
            *self.0.lock().unwrap() = Some(serde_json::to_value(input)?);
            let event: Event =
                serde_json::from_value(json!({"type":"RUN_ERROR","message":"producer failed"}))?;
            Ok(Box::pin(stream::iter(vec![Ok(event)])))
        }
    }
    #[tokio::test]
    async fn resume_answers_are_forwarded_and_run_error_is_delivered() {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
        let resume = serde_json::from_value(
            json!({"interruptId":"approval-1","status":"resolved","payload":{"approved":true}}),
        )
        .unwrap();
        let result = CaptureAgent(captured.clone())
            .run_agent(&RunAgentParams::new().with_resume(vec![resume]), ())
            .await;
        assert!(
            result.is_ok(),
            "a delivered RUN_ERROR is a successful stream consumption"
        );
        let input = captured.lock().unwrap();
        assert_eq!(
            input.as_ref().unwrap()["resume"][0]["interruptId"],
            "approval-1"
        );
        assert_eq!(
            input.as_ref().unwrap()["resume"][0]["payload"]["approved"],
            true
        );
    }

    struct ChunkAgent;
    #[async_trait::async_trait]
    impl Agent for ChunkAgent {
        async fn run(
            &self,
            _input: &RunAgentInput<JsonValue, JsonValue>,
        ) -> Result<EventStream<'async_trait, JsonValue>, AgentError> {
            let values = [
                json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
                json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m","role":"assistant","delta":"A"}),
                json!({"type":"TEXT_MESSAGE_CHUNK","delta":"B"}),
                json!({"type":"TOOL_CALL_CHUNK","toolCallId":"tc","toolCallName":"search","parentMessageId":"m","delta":"{"}),
                json!({"type":"TOOL_CALL_CHUNK","delta":"}"}),
                json!({"type":"REASONING_MESSAGE_CHUNK","messageId":"rm","delta":"think"}),
                json!({"type":"REASONING_MESSAGE_CHUNK","delta":" more"}),
                json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
                json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"sm","role":"assistant","subagentRunId":"s","delta":"worker"}),
                json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
            ];
            Ok(Box::pin(stream::iter(
                values
                    .into_iter()
                    .map(|v| Ok(serde_json::from_value::<Event>(v).unwrap())),
            )))
        }
    }
    struct EventOrder(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
    #[async_trait::async_trait]
    impl crate::subscriber::AgentSubscriber for EventOrder {
        async fn on_event(
            &self,
            event: &Event,
            _params: crate::subscriber::AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().push(
                serde_json::to_value(event)?["type"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            Ok(AgentStateMutation::default())
        }
    }
    #[tokio::test]
    async fn chunk_callbacks_expand_before_subscribers_and_close_on_terminals() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let result = ChunkAgent
            .run_agent(
                &RunAgentParams::new()
                    .with_thread_id("t".into())
                    .with_run_id("r".into()),
                (EventOrder(seen.clone()),),
            )
            .await
            .unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "RUN_STARTED",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_END",
                "TOOL_CALL_START",
                "TOOL_CALL_ARGS",
                "TOOL_CALL_ARGS",
                "TOOL_CALL_END",
                "REASONING_MESSAGE_START",
                "REASONING_MESSAGE_CONTENT",
                "REASONING_MESSAGE_CONTENT",
                "SUBAGENT_STARTED",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_END",
                "SUBAGENT_FINISHED",
                "REASONING_MESSAGE_END",
                "RUN_FINISHED",
            ]
        );
        assert_eq!(result.new_messages.len(), 3);
        assert_eq!(result.new_messages[0].content(), Some("AB"));
        assert_eq!(result.new_messages[1].content(), Some("think more"));
        assert_eq!(result.new_messages[2].content(), Some("worker"));
    }

    #[tokio::test]
    async fn run_result_exposes_messages_state_result_outcome_and_usage() {
        let result = OfflineAgent
            .run_agent(
                &RunAgentParams::new()
                    .with_thread_id("t".into())
                    .with_run_id("r".into()),
                (),
            )
            .await
            .unwrap();
        assert_eq!(result.result, json!({"ok":true}));
        assert_eq!(result.new_state, json!({"done":true}));
        assert_eq!(result.new_messages.len(), 1);
        assert_eq!(result.new_messages[0].content(), Some("done"));
        assert!(matches!(
            result.outcome,
            Some(RunFinishedOutcome::Success { .. })
        ));
        assert_eq!(result.usage.unwrap()[0].input_tokens, Some(3));
    }
}
