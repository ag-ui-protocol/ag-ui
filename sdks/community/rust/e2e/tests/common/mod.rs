//! The one piece of shared setup: an agent on a real port.
//!
//! Nothing between the two halves of the SDK is mocked here. `server` binds a
//! loopback socket, mounts the agent with the real
//! [`route_agui`](ag_ui::axum::RouterExt::route_agui), and hands back a URL that
//! `ag-ui-client`'s own HTTP transport connects to. Everything a test asserts on
//! has therefore been through SSE framing, content negotiation, chunk
//! normalization and delta application for real.

use ag_ui::axum::{AgentEndpoint, RouterExt};
use ag_ui::client::transport::HttpTransport;
use ag_ui::server::Agent;
use axum::Router;
use tokio::net::TcpListener;

/// Mounts `agent` at `/agent` on a free loopback port and returns its URL.
pub async fn serve(agent: impl Agent + 'static) -> String {
    serve_endpoint(AgentEndpoint::new(agent)).await
}

/// The same, for an endpoint whose defaults a test has changed.
///
/// Port 0 so tests can run concurrently — and they do, both under nextest and
/// inside a single test that opens several threads at once.
pub async fn serve_endpoint<A: Agent + 'static>(endpoint: AgentEndpoint<A>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port on loopback");
    let addr = listener.local_addr().expect("the bound address");
    let app = Router::new().route_agui_with("/agent", endpoint);

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("the server to run");
    });

    format!("http://{addr}/agent")
}

/// The client's real HTTP transport, pointed at a served agent.
pub fn transport(url: &str) -> HttpTransport {
    HttpTransport::new(url).expect("a valid endpoint URL")
}
