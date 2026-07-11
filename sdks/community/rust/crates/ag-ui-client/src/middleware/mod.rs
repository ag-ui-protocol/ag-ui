//! Middleware system for AG-UI event stream transformation.
//!
//! This module provides an abstract trait for composable event stream transformation.
//! Middlewares can be chained together to create processing pipelines that transform,
//! filter, or augment event streams.
//!
//! # Example
//!
//! ```rust,no_run
//! use ag_ui_client::middleware::filter_tool_calls::{FilterToolCallsMiddleware, FilterConfig};
//!
//! # fn example() {
//! let filter = FilterToolCallsMiddleware::new(FilterConfig::allow(["search", "calculate"]));
//! # }
//! ```

pub mod filter_tool_calls;

use crate::core::AgentState;
use crate::stream::EventStream;

/// A stream transformer that can modify, filter, or augment event streams.
///
/// Unlike the full `Middleware` trait, `StreamTransformer` operates purely on
/// event streams without knowledge of the underlying agent. This makes it
/// simpler to compose and use.
pub trait StreamTransformer<StateT: AgentState = serde_json::Value>: Send + Sync {
    /// Transform an event stream into another event stream.
    ///
    /// # Arguments
    ///
    /// * `stream` - The input event stream to transform
    ///
    /// # Returns
    ///
    /// A transformed event stream.
    fn transform<'a>(
        &'a self,
        stream: EventStream<'a, StateT>,
    ) -> EventStream<'a, StateT>;
}

/// Extension trait for chaining stream transformers.
pub trait EventStreamExt<'a, StateT: AgentState>: Sized {
    /// Apply a stream transformer to this stream.
    fn with_transformer<T: StreamTransformer<StateT>>(
        self,
        transformer: &'a T,
    ) -> EventStream<'a, StateT>;
}

impl<'a, StateT: AgentState + 'a> EventStreamExt<'a, StateT> for EventStream<'a, StateT> {
    fn with_transformer<T: StreamTransformer<StateT>>(
        self,
        transformer: &'a T,
    ) -> EventStream<'a, StateT> {
        transformer.transform(self)
    }
}

/// A chain of stream transformers that can be applied to an event stream.
pub struct TransformerChain<StateT: AgentState = serde_json::Value> {
    transformers: Vec<Box<dyn StreamTransformer<StateT>>>,
}

impl<StateT: AgentState> Default for TransformerChain<StateT> {
    fn default() -> Self {
        Self::new()
    }
}

impl<StateT: AgentState + 'static> TransformerChain<StateT> {
    /// Create a new empty transformer chain.
    pub fn new() -> Self {
        Self {
            transformers: Vec::new(),
        }
    }

    /// Add a transformer to the chain.
    ///
    /// Transformers are applied in the order they are added.
    pub fn push<T: StreamTransformer<StateT> + 'static>(mut self, transformer: T) -> Self {
        self.transformers.push(Box::new(transformer));
        self
    }

    /// Apply all transformers in the chain to an event stream.
    pub fn apply<'a>(&'a self, mut stream: EventStream<'a, StateT>) -> EventStream<'a, StateT> {
        for transformer in &self.transformers {
            stream = transformer.transform(stream);
        }
        stream
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::{BaseEvent, Event, RunFinishedEvent, RunStartedEvent};
    use crate::core::types::{RunId, ThreadId};
    use crate::core::JsonValue;
    use futures::stream::{self, StreamExt};

    // Test transformer that counts events
    struct CountingTransformer {
        count: std::sync::atomic::AtomicUsize,
    }

    impl CountingTransformer {
        fn new() -> Self {
            Self {
                count: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn get_count(&self) -> usize {
            self.count.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl StreamTransformer<JsonValue> for CountingTransformer {
        fn transform<'a>(
            &'a self,
            stream: EventStream<'a, JsonValue>,
        ) -> EventStream<'a, JsonValue> {
            let count = &self.count;
            Box::pin(stream.map(move |event| {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                event
            }))
        }
    }

    fn create_test_stream() -> EventStream<'static, JsonValue> {
        let events = vec![
            Ok(Event::RunStarted(RunStartedEvent {
                base: BaseEvent {
                    timestamp: None,
                    raw_event: None,
                },
                thread_id: ThreadId::new("test-thread"),
                run_id: RunId::new("test-run"),
            })),
            Ok(Event::RunFinished(RunFinishedEvent {
                base: BaseEvent {
                    timestamp: None,
                    raw_event: None,
                },
                thread_id: ThreadId::new("test-thread"),
                run_id: RunId::new("test-run"),
                result: None,
            })),
        ];
        Box::pin(stream::iter(events))
    }

    #[tokio::test]
    async fn test_transformer_processes_events() {
        let transformer = CountingTransformer::new();
        let stream = create_test_stream();

        let transformed = transformer.transform(stream);
        let events: Vec<_> = transformed.collect().await;

        assert_eq!(events.len(), 2);
        assert_eq!(transformer.get_count(), 2);
    }

    #[tokio::test]
    async fn test_transformer_chain() {
        let counter1 = CountingTransformer::new();
        let counter2 = CountingTransformer::new();

        let chain = TransformerChain::new().push(counter1).push(counter2);

        let stream = create_test_stream();
        let transformed = chain.apply(stream);
        let events: Vec<_> = transformed.collect().await;

        assert_eq!(events.len(), 2);
        // Each counter should have seen 2 events
        // Note: we can't access the counts after pushing into the chain
        // because they're moved. This is just to verify the chain works.
    }

    #[tokio::test]
    async fn test_event_stream_ext() {
        let transformer = CountingTransformer::new();
        let stream = create_test_stream();

        let transformed = stream.with_transformer(&transformer);
        let events: Vec<_> = transformed.collect().await;

        assert_eq!(events.len(), 2);
        assert_eq!(transformer.get_count(), 2);
    }
}
