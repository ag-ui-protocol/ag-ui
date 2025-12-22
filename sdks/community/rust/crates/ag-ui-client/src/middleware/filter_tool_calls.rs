//! Security middleware for filtering tool calls based on allow/block lists.
//!
//! This middleware can be used to restrict which tools an agent is allowed to call,
//! providing a security layer between the agent and the client.
//!
//! # Example
//!
//! ```rust,no_run
//! use ag_ui_client::middleware::filter_tool_calls::{FilterToolCallsMiddleware, FilterConfig};
//! use ag_ui_client::middleware::{StreamTransformer, EventStreamExt};
//!
//! // Only allow specific tools
//! let middleware = FilterToolCallsMiddleware::new(
//!     FilterConfig::allow(["web_search", "calculator", "read_file"])
//! );
//!
//! // Or block dangerous tools
//! let middleware = FilterToolCallsMiddleware::new(
//!     FilterConfig::block(["delete_file", "execute_code", "send_email"])
//! );
//! ```

use super::StreamTransformer;
use crate::core::event::Event;
use crate::core::AgentState;
use crate::stream::EventStream;
use futures::StreamExt;
use std::collections::HashSet;
use std::sync::Mutex;

/// Configuration for tool call filtering.
#[derive(Debug, Clone)]
pub enum FilterConfig {
    /// Only allow tools in this set (block all others)
    Allow(HashSet<String>),
    /// Block tools in this set (allow all others)
    Block(HashSet<String>),
}

impl FilterConfig {
    /// Create a filter config that only allows the specified tools.
    ///
    /// All tools not in this list will be blocked.
    ///
    /// # Arguments
    ///
    /// * `tools` - An iterator of tool names to allow
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_client::middleware::filter_tool_calls::FilterConfig;
    ///
    /// let config = FilterConfig::allow(["search", "calculate"]);
    /// ```
    pub fn allow<I, S>(tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Allow(tools.into_iter().map(Into::into).collect())
    }

    /// Create a filter config that blocks the specified tools.
    ///
    /// All tools not in this list will be allowed.
    ///
    /// # Arguments
    ///
    /// * `tools` - An iterator of tool names to block
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_client::middleware::filter_tool_calls::FilterConfig;
    ///
    /// let config = FilterConfig::block(["delete_file", "execute_code"]);
    /// ```
    pub fn block<I, S>(tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Block(tools.into_iter().map(Into::into).collect())
    }
}

/// Middleware that filters tool calls based on allow/block lists.
///
/// This middleware intercepts tool call events and filters out calls to
/// tools that are not allowed (or are explicitly blocked). When a tool call
/// is filtered, all related events (ARGS, END, RESULT) are also filtered.
#[derive(Debug)]
pub struct FilterToolCallsMiddleware {
    config: FilterConfig,
    /// Tool call IDs that are being blocked (to filter ARGS, END, RESULT)
    blocked_ids: Mutex<HashSet<String>>,
}

impl FilterToolCallsMiddleware {
    /// Create a new FilterToolCallsMiddleware with the specified configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - The filter configuration (allow or block list)
    pub fn new(config: FilterConfig) -> Self {
        Self {
            config,
            blocked_ids: Mutex::new(HashSet::new()),
        }
    }

    /// Check if a tool should be filtered based on the configuration.
    fn should_filter(&self, tool_name: &str) -> bool {
        match &self.config {
            FilterConfig::Allow(allowed) => !allowed.contains(tool_name),
            FilterConfig::Block(blocked) => blocked.contains(tool_name),
        }
    }
}

impl<StateT: AgentState> StreamTransformer<StateT> for FilterToolCallsMiddleware {
    fn transform<'a>(&'a self, stream: EventStream<'a, StateT>) -> EventStream<'a, StateT> {
        Box::pin(stream.filter_map(move |result| async move {
            match result {
                Ok(event) => match &event {
                    // Handle TOOL_CALL_START events
                    Event::ToolCallStart(e) => {
                        if self.should_filter(&e.tool_call_name) {
                            // Track this tool call ID as blocked
                            self.blocked_ids
                                .lock()
                                .expect("blocked_ids mutex poisoned")
                                .insert(e.tool_call_id.to_string());
                            None // Filter out this event
                        } else {
                            Some(Ok(event)) // Allow this event
                        }
                    }

                    // Handle TOOL_CALL_ARGS events
                    Event::ToolCallArgs(e) => {
                        if self
                            .blocked_ids
                            .lock()
                            .expect("blocked_ids mutex poisoned")
                            .contains(&e.tool_call_id.to_string())
                        {
                            None // Filter out
                        } else {
                            Some(Ok(event))
                        }
                    }

                    // Handle TOOL_CALL_END events
                    Event::ToolCallEnd(e) => {
                        if self
                            .blocked_ids
                            .lock()
                            .expect("blocked_ids mutex poisoned")
                            .contains(&e.tool_call_id.to_string())
                        {
                            None // Filter out
                        } else {
                            Some(Ok(event))
                        }
                    }

                    // Handle TOOL_CALL_RESULT events
                    Event::ToolCallResult(e) => {
                        let mut blocked = self.blocked_ids.lock().expect("blocked_ids mutex poisoned");
                        if blocked.remove(&e.tool_call_id.to_string()) {
                            None // Filter and cleanup
                        } else {
                            Some(Ok(event))
                        }
                    }

                    // Handle TOOL_CALL_CHUNK events
                    Event::ToolCallChunk(e) => {
                        if let Some(ref tool_call_id) = e.tool_call_id {
                            if self
                                .blocked_ids
                                .lock()
                                .expect("blocked_ids mutex poisoned")
                                .contains(&tool_call_id.to_string())
                            {
                                return None; // Filter out
                            }
                        }
                        Some(Ok(event))
                    }

                    // Allow all other events through
                    _ => Some(Ok(event)),
                },
                Err(e) => Some(Err(e)),
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::{
        BaseEvent, Event, RunFinishedEvent, RunStartedEvent, TextMessageContentEvent,
        TextMessageEndEvent, TextMessageStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
        ToolCallResultEvent, ToolCallStartEvent,
    };
    use crate::core::types::{MessageId, Role, RunId, ThreadId, ToolCallId};
    use crate::core::JsonValue;
    use futures::stream::{self, StreamExt};

    fn base_event() -> BaseEvent {
        BaseEvent {
            timestamp: None,
            raw_event: None,
        }
    }

    fn run_started() -> Event<JsonValue> {
        Event::RunStarted(RunStartedEvent {
            base: base_event(),
            thread_id: ThreadId::new("test"),
            run_id: RunId::new("test"),
        })
    }

    fn run_finished() -> Event<JsonValue> {
        Event::RunFinished(RunFinishedEvent {
            base: base_event(),
            thread_id: ThreadId::new("test"),
            run_id: RunId::new("test"),
            result: None,
        })
    }

    fn tool_call_start(id: &str, name: &str) -> Event<JsonValue> {
        Event::ToolCallStart(ToolCallStartEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(id),
            tool_call_name: name.to_string(),
            parent_message_id: None,
        })
    }

    fn tool_call_args(id: &str) -> Event<JsonValue> {
        Event::ToolCallArgs(ToolCallArgsEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(id),
            delta: "{}".to_string(),
        })
    }

    fn tool_call_end(id: &str) -> Event<JsonValue> {
        Event::ToolCallEnd(ToolCallEndEvent {
            base: base_event(),
            tool_call_id: ToolCallId::new(id),
        })
    }

    fn tool_call_result(id: &str) -> Event<JsonValue> {
        Event::ToolCallResult(ToolCallResultEvent {
            base: base_event(),
            message_id: MessageId::new("msg1"),
            tool_call_id: ToolCallId::new(id),
            content: "result".to_string(),
            role: Role::Tool,
        })
    }

    fn text_message_start() -> Event<JsonValue> {
        Event::TextMessageStart(TextMessageStartEvent {
            base: base_event(),
            message_id: MessageId::new("msg1"),
            role: Role::Assistant,
        })
    }

    fn text_message_content() -> Event<JsonValue> {
        Event::TextMessageContent(TextMessageContentEvent {
            base: base_event(),
            message_id: MessageId::new("msg1"),
            delta: "Hello".to_string(),
        })
    }

    fn text_message_end() -> Event<JsonValue> {
        Event::TextMessageEnd(TextMessageEndEvent {
            base: base_event(),
            message_id: MessageId::new("msg1"),
        })
    }

    fn create_stream(events: Vec<Event<JsonValue>>) -> EventStream<'static, JsonValue> {
        let events: Vec<_> = events.into_iter().map(Ok).collect();
        Box::pin(stream::iter(events))
    }

    #[tokio::test]
    async fn test_allowlist_filters_non_allowed_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::allow(["allowed_tool"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "blocked_tool"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            tool_call_result("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // Only run_started and run_finished should remain
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_allowlist_allows_listed_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::allow(["search"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "search"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // All events should pass through
        assert_eq!(results.len(), 5);
    }

    #[tokio::test]
    async fn test_blocklist_filters_blocked_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::block(["dangerous_tool"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "dangerous_tool"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // Only run_started and run_finished should remain
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_blocklist_allows_non_blocked_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::block(["dangerous_tool"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "safe_tool"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // All events should pass through
        assert_eq!(results.len(), 5);
    }

    #[tokio::test]
    async fn test_non_tool_events_pass_through() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::allow(["search"]));

        let events = vec![
            run_started(),
            text_message_start(),
            text_message_content(),
            text_message_end(),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // All events should pass through
        assert_eq!(results.len(), 5);
    }

    #[tokio::test]
    async fn test_blocked_id_cleanup_on_result() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::block(["blocked_tool"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "blocked_tool"),
            tool_call_result("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let _results: Vec<_> = transformed.collect().await;

        // After stream completes, blocked_ids should be empty
        assert!(middleware.blocked_ids.lock().expect("mutex poisoned").is_empty());
    }

    #[tokio::test]
    async fn test_multiple_tool_calls_mixed_filtering() {
        let middleware =
            FilterToolCallsMiddleware::new(FilterConfig::allow(["allowed1", "allowed2"]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "allowed1"),
            tool_call_start("tc2", "blocked"),
            tool_call_start("tc3", "allowed2"),
            tool_call_args("tc1"),
            tool_call_args("tc2"),
            tool_call_args("tc3"),
            tool_call_end("tc1"),
            tool_call_end("tc2"),
            tool_call_end("tc3"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // Should have: run_started + (start, args, end for tc1 and tc3) + run_finished = 8
        assert_eq!(results.len(), 8);
    }

    #[tokio::test]
    async fn test_empty_allowlist_blocks_all_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::allow::<[&str; 0], _>([]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "any_tool"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // Only run_started and run_finished should remain
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_empty_blocklist_allows_all_tools() {
        let middleware = FilterToolCallsMiddleware::new(FilterConfig::block::<[&str; 0], _>([]));

        let events = vec![
            run_started(),
            tool_call_start("tc1", "any_tool"),
            tool_call_args("tc1"),
            tool_call_end("tc1"),
            run_finished(),
        ];

        let stream = create_stream(events);
        let transformed = middleware.transform(stream);
        let results: Vec<_> = transformed.collect().await;

        // All events should pass through
        assert_eq!(results.len(), 5);
    }
}
