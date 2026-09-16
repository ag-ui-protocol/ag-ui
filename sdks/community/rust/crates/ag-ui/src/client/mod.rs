//! Consume an AG-UI agent through local conversations.
//!
//! [`Thread`] maintains history, current state and pending interrupts. Every
//! `send` or `resume_many` returns a checked, lazily dispatched [`RunStream`].
//! Use [`RunStream::collect_report`] for the outcome and retained diagnostics,
//! or consume [`Update`] values for a streaming UI. Configure `on_event` to
//! observe every decoded event while preserving automatic state management.
//!
//! With feature `http`, `HttpAgent::new(url)?.thread(id)` is the standard
//! entrypoint. [`RemoteAgent::run_events`] and [`Transport`] expose unassembled
//! events for proxies and custom transports. The `client` feature requires no
//! executor; HTTP support is an additional opt-in feature.
//!
//! ```
//! use ag_ui::client::{Thread, transport::ReplayTransport};
//! use ag_ui::Event;
//! let mut thread = Thread::new(ReplayTransport::new([]), "thread-1");
//! thread.set_state(serde_json::json!({"checked": false}))?;
//! assert_eq!(thread.state()?["checked"], false);
//! // Preparing and dropping a request without polling does not send or append it.
//! drop(thread.send("Hello")?);
//! assert!(thread.messages().is_empty());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

pub mod agent;
pub mod apply;
pub mod chunks;
pub mod error;
pub mod interrupts;
pub mod thread;
pub mod transport;
pub mod verify;

pub use agent::{RemoteAgent, RunParams};
pub use apply::{
    Applier, Changed, MessageChange, MessageChangeKind, ReasoningChange, ReasoningChangeKind,
    Subagent, SubagentChange, SubagentChangeKind, SubagentStatus,
};
pub use chunks::{ChunkNormalizer, normalize_all};
pub use error::{Error, Result};
pub use interrupts::{InterruptExt, ResumeBuilder, interrupts_of, resume_run};
pub use thread::{
    AbortHandle, MessageUpdate, ReasoningUpdate, ResumeSubmission, RunDiagnostic, RunEnd,
    RunReport, RunStream, StateViewError, SubagentUpdate, SubmissionStatus, Thread, ThreadBuilder,
    ThreadSnapshot, Update,
};
pub use transport::{EventStream, Transport};
pub use verify::{Verifier, verify_all};

#[cfg(feature = "http")]
pub use agent::{HttpAgent, HttpAgentBuilder};
