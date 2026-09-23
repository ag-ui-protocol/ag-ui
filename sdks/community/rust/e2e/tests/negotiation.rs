//! What the endpoint refuses, and how the client hears about it.
//!
//! A run that fails is a `200` with `RUN_ERROR` in it. A request the endpoint
//! will not answer at all is something else entirely, and a client has to be
//! able to tell the two apart — "the agent errored", "you asked for a body I
//! cannot send", "nothing is listening", "something answered but it was not an
//! agent" are four different bugs. This checks that the refusals arrive as
//! distinguishable errors and that a refused request never reaches the agent.

mod common;

use ag_ui::RunOutcome;
use ag_ui::client::{Error as ClientError, HttpAgent, RunEnd, RunParams, Thread, Update};
use ag_ui::server::{Agent, Result, RunContext};
use axum::Router;
use axum::routing::post;
use common::{serve, transport};
use futures_util::StreamExt as _;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

/// Announces that it ran, so a test can assert that it did not.
struct Tattletale {
    ran: UnboundedSender<()>,
}

impl Agent for Tattletale {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let _ = self.ran.send(());
        ctx.say("hello")?;
        Ok(RunOutcome::Success)
    }
}

/// The one error a run yields, or a panic naming what came instead.
async fn only_error(agent: &HttpAgent, params: RunParams) -> ClientError {
    let items: Vec<_> = agent.run_events(params).collect().await;
    let mut items = items.into_iter();
    match (items.next(), items.next()) {
        (Some(Err(error)), None) => error,
        (first, second) => panic!("expected exactly one error, got {first:?} then {second:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_accept_the_endpoint_cannot_satisfy_is_refused_before_the_agent_runs() {
    let (ran, mut ran_rx) = unbounded_channel();
    let url = serve(Tattletale { ran }).await;

    let agent = HttpAgent::builder(&url)
        .header("accept", "application/xml")
        .build()
        .expect("a valid endpoint");

    let error = only_error(&agent, RunParams::new("t", "r")).await;
    match &error {
        ClientError::Http { status, body } => {
            assert_eq!(*status, 406);
            // The refusal says what it could have sent instead.
            assert!(body.contains("text/event-stream"), "{body}");
        }
        other => panic!("expected a 406, got {other:?}"),
    }

    // The whole response has been read by now, so this is not a race: a
    // negotiation failure is decided before the run is built.
    assert!(
        ran_rx.try_recv().is_err(),
        "the agent ran for a request the endpoint had already refused"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_accept_the_endpoint_can_satisfy_is_served() {
    let (ran, _ran_rx) = unbounded_channel();
    let url = serve(Tattletale { ran }).await;

    for accept in [
        "*/*",
        "text/event-stream",
        "text/*",
        "application/json, text/*;q=0.1",
    ] {
        let agent = HttpAgent::builder(&url)
            .header("accept", accept)
            .build()
            .expect("a valid endpoint");
        let events: Vec<_> = agent.run_events(RunParams::new("t", "r")).collect().await;
        assert!(
            events.iter().all(std::result::Result::is_ok),
            "{accept} should have been served: {events:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_path_is_an_http_error_rather_than_an_empty_stream() {
    let (ran, mut ran_rx) = unbounded_channel();
    let url = serve(Tattletale { ran }).await;
    let elsewhere = url.replace("/agent", "/nowhere");

    let agent = HttpAgent::from_transport(transport(&elsewhere));
    let error = only_error(&agent, RunParams::new("t", "r")).await;

    assert!(
        matches!(&error, ClientError::Http { status: 404, .. }),
        "{error:?}"
    );
    assert!(ran_rx.try_recv().is_err(), "the agent should not have run");
}

/// The refusal that does not look like one. A gateway that wants a login, a
/// health check answering on the wrong path, a proxy reporting its own trouble
/// as JSON: all of them are `200`, and none of them is an event stream. The
/// status says nothing, so the client checks the response media type before
/// reading the body. It must not mistake this for an empty successful run.
#[tokio::test(flavor = "multi_thread")]
async fn a_two_hundred_that_is_not_an_event_stream_is_reported_as_a_failed_run() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port on loopback");
    let addr = listener.local_addr().expect("the bound address");
    let app = Router::new().route("/agent", post(|| async { "<html>please log in</html>" }));
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("the server to run");
    });

    let mut thread = Thread::<_>::new(transport(&format!("http://{addr}/agent")), "gateway");
    let mut updates = Vec::new();
    {
        let mut run = thread.send("hello?").expect("run preflight");
        while let Some(update) = run.next().await {
            updates.push(update);
        }
    }

    match updates.last() {
        Some(Update::Done(RunEnd::Failed { message, .. })) => {
            assert!(
                message.contains("Content-Type") && message.contains("text/plain"),
                "the report should identify the response format: {message}"
            );
        }
        other => panic!("a body with no run in it must not end as {other:?}"),
    }
    assert!(
        updates
            .iter()
            .any(|update| matches!(update, Update::Error(ClientError::UnexpectedContentType(_)))),
        "{updates:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_listening_is_a_transport_error_not_a_protocol_one() {
    // Bind, take the address, then let it go: nothing is listening there now.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port on loopback");
    let addr = listener.local_addr().expect("the bound address");
    drop(listener);

    let agent = HttpAgent::from_transport(transport(&format!("http://{addr}/agent")));
    let error = only_error(&agent, RunParams::new("t", "r")).await;

    assert!(
        matches!(error, ClientError::Transport(_)),
        "a dead endpoint is not a protocol violation: {error:?}"
    );
}
