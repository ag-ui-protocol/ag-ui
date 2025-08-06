use futures::stream::BoxStream;
use ag_ui_core::event::Event;
use crate::agent::AgentError;

pub type EventStream<'a, StateT> = BoxStream<'a, Result<Event<StateT>, AgentError>>;
