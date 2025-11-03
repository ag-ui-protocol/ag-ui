use crate::agent::AgentError;
use crate::core::event::Event;
use futures::stream::BoxStream;

pub type EventStream<'a, StateT> = BoxStream<'a, Result<Event<StateT>, AgentError>>;
