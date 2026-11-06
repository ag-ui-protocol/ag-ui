use crate::agent::AgentError;
use crate::core::event::Event;
use futures::stream::BoxStream;

/// Low-level canonical events. Transport/processing errors are consumer failures,
/// while a RUN_ERROR event is a producer-reported outcome. This stream does not
/// itself verify lifecycle completion; use Agent::run_input for that guarantee.
pub type EventStream<'a, StateT> = BoxStream<'a, Result<Event<StateT>, AgentError>>;
