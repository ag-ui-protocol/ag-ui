//! Event stream verification for AG-UI protocol compliance.
//!
//! This module provides a state machine that validates AG-UI event streams
//! to ensure they follow the protocol correctly. It tracks active messages,
//! tool calls, steps, and run state to catch invalid sequences.
//!
//! # Example
//!
//! ```rust,no_run
//! use ag_ui_client::verify::EventVerifier;
//! use futures::StreamExt;
//!
//! # async fn example() {
//! let verifier = EventVerifier::new();
//! // let verified_stream = verifier.verify_stream(event_stream);
//! # }
//! ```

use crate::error::AgUiClientError;
use ag_ui_core::event::{Event, EventType};
use ag_ui_core::AgentState;
use futures::stream::{BoxStream, StreamExt};
use std::collections::HashSet;

/// Event stream verifier for AG-UI protocol compliance.
///
/// Tracks the state of an event stream and validates that events follow
/// the correct sequence according to the AG-UI protocol.
#[derive(Debug)]
pub struct EventVerifier {
    /// Active text messages (message_id -> active)
    active_messages: HashSet<String>,
    /// Active tool calls (tool_call_id -> active)
    active_tool_calls: HashSet<String>,
    /// Active steps (step_name -> active)
    active_steps: HashSet<String>,
    /// Whether a run has started
    run_started: bool,
    /// Whether the run has finished
    run_finished: bool,
    /// Whether the run has errored
    run_error: bool,
    /// Whether first event has been received
    first_event_received: bool,
    /// Whether a thinking step is active
    active_thinking: bool,
    /// Whether a thinking message is active within the thinking step
    active_thinking_message: bool,
    /// Debug mode - logs events when enabled
    debug: bool,
}

impl Default for EventVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl EventVerifier {
    /// Create a new EventVerifier with default settings.
    pub fn new() -> Self {
        Self {
            active_messages: HashSet::new(),
            active_tool_calls: HashSet::new(),
            active_steps: HashSet::new(),
            run_started: false,
            run_finished: false,
            run_error: false,
            first_event_received: false,
            active_thinking: false,
            active_thinking_message: false,
            debug: false,
        }
    }

    /// Enable or disable debug mode.
    ///
    /// When debug mode is enabled, each event is logged before verification.
    pub fn with_debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    /// Reset state for a new run.
    ///
    /// Called when a new RUN_STARTED event is received after RUN_FINISHED.
    fn reset_run_state(&mut self) {
        self.active_messages.clear();
        self.active_tool_calls.clear();
        self.active_steps.clear();
        self.active_thinking = false;
        self.active_thinking_message = false;
        self.run_finished = false;
        self.run_error = false;
        self.run_started = true;
    }

    /// Verify a single event, returning an error if the event is invalid.
    ///
    /// # Arguments
    ///
    /// * `event` - The event to verify
    ///
    /// # Returns
    ///
    /// * `Ok(())` if the event is valid
    /// * `Err(AgUiClientError)` if the event violates protocol rules
    pub fn verify<StateT: AgentState>(&mut self, event: &Event<StateT>) -> Result<(), AgUiClientError> {
        let event_type = event.event_type();

        if self.debug {
            log::debug!("[VERIFY]: {:?}", event_type);
        }

        // Check if run has errored
        if self.run_error {
            return Err(AgUiClientError::Execution {
                message: format!(
                    "Cannot send event type '{:?}': The run has already errored with 'RUN_ERROR'. No further events can be sent.",
                    event_type
                ),
            });
        }

        // Check if run has already finished (but allow new RUN_STARTED to start a new run)
        if self.run_finished
            && event_type != EventType::RunError
            && event_type != EventType::RunStarted
        {
            return Err(AgUiClientError::Execution {
                message: format!(
                    "Cannot send event type '{:?}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.",
                    event_type
                ),
            });
        }

        // Handle first event requirement and sequential RUN_STARTED
        if !self.first_event_received {
            self.first_event_received = true;
            if event_type != EventType::RunStarted && event_type != EventType::RunError {
                return Err(AgUiClientError::Execution {
                    message: "First event must be 'RUN_STARTED'".to_string(),
                });
            }
        } else if event_type == EventType::RunStarted {
            // Allow RUN_STARTED after RUN_FINISHED (new run), but not during an active run
            if self.run_started && !self.run_finished {
                return Err(AgUiClientError::Execution {
                    message: "Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.".to_string(),
                });
            }
            // If we're here, it's either the first RUN_STARTED or a new run after RUN_FINISHED
            if self.run_finished {
                // This is a new run after the previous one finished, reset state
                self.reset_run_state();
            }
        }

        // Validate event based on type and current state
        match event {
            // Text message flow
            Event::TextMessageStart(e) => {
                let message_id = e.message_id.to_string();

                // Check if this message is already in progress
                if self.active_messages.contains(&message_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '{}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.",
                            message_id
                        ),
                    });
                }

                self.active_messages.insert(message_id);
            }

            Event::TextMessageContent(e) => {
                let message_id = e.message_id.to_string();

                // Must be in a message with this ID
                if !self.active_messages.contains(&message_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '{}'. Start a text message with 'TEXT_MESSAGE_START' first.",
                            message_id
                        ),
                    });
                }
            }

            Event::TextMessageEnd(e) => {
                let message_id = e.message_id.to_string();

                // Must be in a message with this ID
                if !self.active_messages.contains(&message_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '{}'. A 'TEXT_MESSAGE_START' event must be sent first.",
                            message_id
                        ),
                    });
                }

                // Remove message from active set
                self.active_messages.remove(&message_id);
            }

            // Tool call flow
            Event::ToolCallStart(e) => {
                let tool_call_id = e.tool_call_id.to_string();

                // Check if this tool call is already in progress
                if self.active_tool_calls.contains(&tool_call_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TOOL_CALL_START' event: A tool call with ID '{}' is already in progress. Complete it with 'TOOL_CALL_END' first.",
                            tool_call_id
                        ),
                    });
                }

                self.active_tool_calls.insert(tool_call_id);
            }

            Event::ToolCallArgs(e) => {
                let tool_call_id = e.tool_call_id.to_string();

                // Must be in a tool call with this ID
                if !self.active_tool_calls.contains(&tool_call_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '{}'. Start a tool call with 'TOOL_CALL_START' first.",
                            tool_call_id
                        ),
                    });
                }
            }

            Event::ToolCallEnd(e) => {
                let tool_call_id = e.tool_call_id.to_string();

                // Must be in a tool call with this ID
                if !self.active_tool_calls.contains(&tool_call_id) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '{}'. A 'TOOL_CALL_START' event must be sent first.",
                            tool_call_id
                        ),
                    });
                }

                // Remove tool call from active set
                self.active_tool_calls.remove(&tool_call_id);
            }

            // Step flow
            Event::StepStarted(e) => {
                let step_name = e.step_name.clone();
                if self.active_steps.contains(&step_name) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Step \"{}\" is already active for 'STEP_STARTED'",
                            step_name
                        ),
                    });
                }
                self.active_steps.insert(step_name);
            }

            Event::StepFinished(e) => {
                let step_name = e.step_name.clone();
                if !self.active_steps.contains(&step_name) {
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'STEP_FINISHED' for step \"{}\" that was not started",
                            step_name
                        ),
                    });
                }
                self.active_steps.remove(&step_name);
            }

            // Run flow
            Event::RunStarted(_) => {
                // We've already validated this above
                self.run_started = true;
            }

            Event::RunFinished(_) => {
                // Check that all steps are finished before run ends
                if !self.active_steps.is_empty() {
                    let unfinished_steps: Vec<_> = self.active_steps.iter().collect();
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'RUN_FINISHED' while steps are still active: {:?}",
                            unfinished_steps
                        ),
                    });
                }

                // Check that all messages are finished before run ends
                if !self.active_messages.is_empty() {
                    let unfinished_messages: Vec<_> = self.active_messages.iter().collect();
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'RUN_FINISHED' while text messages are still active: {:?}",
                            unfinished_messages
                        ),
                    });
                }

                // Check that all tool calls are finished before run ends
                if !self.active_tool_calls.is_empty() {
                    let unfinished_tool_calls: Vec<_> = self.active_tool_calls.iter().collect();
                    return Err(AgUiClientError::Execution {
                        message: format!(
                            "Cannot send 'RUN_FINISHED' while tool calls are still active: {:?}",
                            unfinished_tool_calls
                        ),
                    });
                }

                self.run_finished = true;
            }

            Event::RunError(_) => {
                // RUN_ERROR can happen at any time
                self.run_error = true;
            }

            // Thinking flow
            Event::ThinkingStart(_) => {
                if self.active_thinking {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_START' event: A thinking step is already in progress. End it with 'THINKING_END' first.".to_string(),
                    });
                }
                self.active_thinking = true;
            }

            Event::ThinkingEnd(_) => {
                if !self.active_thinking {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_END' event: No active thinking step found. A 'THINKING_START' event must be sent first.".to_string(),
                    });
                }
                self.active_thinking = false;
            }

            Event::ThinkingTextMessageStart(_) => {
                if !self.active_thinking {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step is not in progress. Create one with 'THINKING_START' first.".to_string(),
                    });
                }
                if self.active_thinking_message {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking message is already in progress. Complete it with 'THINKING_TEXT_MESSAGE_END' first.".to_string(),
                    });
                }
                self.active_thinking_message = true;
            }

            Event::ThinkingTextMessageContent(_) => {
                if !self.active_thinking_message {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active thinking message found. Start a message with 'THINKING_TEXT_MESSAGE_START' first.".to_string(),
                    });
                }
            }

            Event::ThinkingTextMessageEnd(_) => {
                if !self.active_thinking_message {
                    return Err(AgUiClientError::Execution {
                        message: "Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking message found. A 'THINKING_TEXT_MESSAGE_START' event must be sent first.".to_string(),
                    });
                }
                self.active_thinking_message = false;
            }

            // All other events are valid
            Event::TextMessageChunk(_)
            | Event::ToolCallChunk(_)
            | Event::ToolCallResult(_)
            | Event::StateSnapshot(_)
            | Event::StateDelta(_)
            | Event::MessagesSnapshot(_)
            | Event::Raw(_)
            | Event::Custom(_) => {}
        }

        Ok(())
    }

    /// Wrap an event stream with verification.
    ///
    /// Returns a new stream that verifies each event before yielding it.
    /// If an event fails verification, the stream yields an error.
    ///
    /// # Arguments
    ///
    /// * `stream` - The event stream to wrap
    ///
    /// # Returns
    ///
    /// A new stream that yields verified events or errors.
    pub fn verify_stream<'a, StateT: AgentState + 'a>(
        mut self,
        stream: BoxStream<'a, Result<Event<StateT>, AgUiClientError>>,
    ) -> BoxStream<'a, Result<Event<StateT>, AgUiClientError>> {
        Box::pin(stream.map(move |result| {
            match result {
                Ok(event) => {
                    self.verify(&event)?;
                    Ok(event)
                }
                Err(e) => Err(e),
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ag_ui_core::event::*;
    use ag_ui_core::types::{MessageId, Role, RunId, ThreadId, ToolCallId};

    fn base_event() -> BaseEvent {
        BaseEvent {
            timestamp: None,
            raw_event: None,
        }
    }

    fn run_started_event() -> Event {
        Event::RunStarted(RunStartedEvent {
            base: base_event(),
            thread_id: ThreadId::new("test-thread"),
            run_id: RunId::new("test-run"),
        })
    }

    fn run_finished_event() -> Event {
        Event::RunFinished(RunFinishedEvent {
            base: base_event(),
            thread_id: ThreadId::new("test-thread"),
            run_id: RunId::new("test-run"),
            result: None,
        })
    }

    fn run_error_event() -> Event {
        Event::RunError(RunErrorEvent {
            base: base_event(),
            message: "Test error".to_string(),
            code: None,
        })
    }

    fn text_message_start_event(message_id: &str) -> Event {
        Event::TextMessageStart(TextMessageStartEvent {
            base: base_event(),
            message_id: MessageId::new(message_id),
            role: Role::Assistant,
        })
    }

    fn text_message_content_event(message_id: &str) -> Event {
        Event::TextMessageContent(TextMessageContentEvent {
            base: base_event(),
            message_id: MessageId::new(message_id),
            delta: "Hello".to_string(),
        })
    }

    fn text_message_end_event(message_id: &str) -> Event {
        Event::TextMessageEnd(TextMessageEndEvent {
            base: base_event(),
            message_id: MessageId::new(message_id),
        })
    }

    fn tool_call_start_event(tool_call_id: &str) -> Event {
        Event::ToolCallStart(ToolCallStartEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(tool_call_id),
            tool_call_name: "test_tool".to_string(),
            parent_message_id: None,
        })
    }

    fn tool_call_args_event(tool_call_id: &str) -> Event {
        Event::ToolCallArgs(ToolCallArgsEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(tool_call_id),
            delta: r#"{"arg": "value"}"#.to_string(),
        })
    }

    fn tool_call_end_event(tool_call_id: &str) -> Event {
        Event::ToolCallEnd(ToolCallEndEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(tool_call_id),
        })
    }

    fn step_started_event(step_name: &str) -> Event {
        Event::StepStarted(StepStartedEvent {
            base: base_event(),
            step_name: step_name.to_string(),
        })
    }

    fn step_finished_event(step_name: &str) -> Event {
        Event::StepFinished(StepFinishedEvent {
            base: base_event(),
            step_name: step_name.to_string(),
        })
    }

    fn thinking_start_event() -> Event {
        Event::ThinkingStart(ThinkingStartEvent {
            base: base_event(),
            title: None,
        })
    }

    fn thinking_end_event() -> Event {
        Event::ThinkingEnd(ThinkingEndEvent {
            base: base_event(),
        })
    }

    fn thinking_message_start_event() -> Event {
        Event::ThinkingTextMessageStart(ThinkingTextMessageStartEvent {
            base: base_event(),
        })
    }

    fn thinking_message_content_event() -> Event {
        Event::ThinkingTextMessageContent(ThinkingTextMessageContentEvent {
            base: base_event(),
            delta: "Thinking...".to_string(),
        })
    }

    fn thinking_message_end_event() -> Event {
        Event::ThinkingTextMessageEnd(ThinkingTextMessageEndEvent {
            base: base_event(),
        })
    }

    #[test]
    fn test_first_event_must_be_run_started() {
        let mut verifier = EventVerifier::new();

        // Non-RUN_STARTED event should fail
        let result = verifier.verify(&text_message_start_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("First event must be 'RUN_STARTED'"));
    }

    #[test]
    fn test_first_event_can_be_run_error() {
        let mut verifier = EventVerifier::new();

        // RUN_ERROR can be first event
        let result = verifier.verify(&run_error_event());
        assert!(result.is_ok());
    }

    #[test]
    fn test_cannot_start_run_while_run_active() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        // Second RUN_STARTED should fail
        let result = verifier.verify(&run_started_event());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Cannot send 'RUN_STARTED' while a run is still active"));
    }

    #[test]
    fn test_text_message_flow() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_content_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_end_event("msg1")).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_cannot_send_content_without_start() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        let result = verifier.verify(&text_message_content_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("No active text message found"));
    }

    #[test]
    fn test_cannot_send_end_without_start() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        let result = verifier.verify(&text_message_end_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("No active text message found"));
    }

    #[test]
    fn test_tool_call_flow() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&tool_call_start_event("tc1")).expect("valid event rejected");
        verifier.verify(&tool_call_args_event("tc1")).expect("valid event rejected");
        verifier.verify(&tool_call_end_event("tc1")).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_cannot_send_args_without_start() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        let result = verifier.verify(&tool_call_args_event("tc1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("No active tool call found"));
    }

    #[test]
    fn test_run_finished_requires_all_streams_closed() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg1")).expect("valid event rejected");

        // Should fail because message is still active
        let result = verifier.verify(&run_finished_event());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("text messages are still active"));
    }

    #[test]
    fn test_run_error_blocks_further_events() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&run_error_event()).expect("valid event rejected");

        // Any event after RUN_ERROR should fail
        let result = verifier.verify(&text_message_start_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already errored with 'RUN_ERROR'"));
    }

    #[test]
    fn test_new_run_started_after_run_finished_resets_state() {
        let mut verifier = EventVerifier::new();

        // First run
        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");

        // Second run - should reset state
        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_end_event("msg1")).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_step_started_finished_tracking() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&step_started_event("step1")).expect("valid event rejected");
        verifier.verify(&step_finished_event("step1")).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_step_finished_without_start() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        let result = verifier.verify(&step_finished_event("step1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("was not started"));
    }

    #[test]
    fn test_thinking_flow_validation() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&thinking_start_event()).expect("valid event rejected");
        verifier.verify(&thinking_message_start_event()).expect("valid event rejected");
        verifier.verify(&thinking_message_content_event()).expect("valid event rejected");
        verifier.verify(&thinking_message_end_event()).expect("valid event rejected");
        verifier.verify(&thinking_end_event()).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_thinking_message_requires_thinking_step() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");

        // Should fail because no thinking step is active
        let result = verifier.verify(&thinking_message_start_event());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("thinking step is not in progress"));
    }

    #[test]
    fn test_cannot_finish_run_with_active_steps() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&step_started_event("step1")).expect("valid event rejected");

        let result = verifier.verify(&run_finished_event());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("steps are still active"));
    }

    #[test]
    fn test_cannot_finish_run_with_active_tool_calls() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&tool_call_start_event("tc1")).expect("valid event rejected");

        let result = verifier.verify(&run_finished_event());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("tool calls are still active"));
    }

    #[test]
    fn test_multiple_concurrent_messages() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg2")).expect("valid event rejected");
        verifier.verify(&text_message_content_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_content_event("msg2")).expect("valid event rejected");
        verifier.verify(&text_message_end_event("msg1")).expect("valid event rejected");
        verifier.verify(&text_message_end_event("msg2")).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");
    }

    #[test]
    fn test_cannot_start_duplicate_message() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&text_message_start_event("msg1")).expect("valid event rejected");

        let result = verifier.verify(&text_message_start_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already in progress"));
    }

    #[test]
    fn test_cannot_send_after_run_finished() {
        let mut verifier = EventVerifier::new();

        verifier.verify(&run_started_event()).expect("valid event rejected");
        verifier.verify(&run_finished_event()).expect("valid event rejected");

        let result = verifier.verify(&text_message_start_event("msg1"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already finished with 'RUN_FINISHED'"));
    }
}
