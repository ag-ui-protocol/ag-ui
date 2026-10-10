//! A complete client/server exchange without a model provider or credentials.
use ag_ui::RunOutcome;
use ag_ui::axum::RouterExt;
use ag_ui::client::{HttpAgent, RunEnd};
use ag_ui::server::{Agent, Result, RunContext};

struct Greeter;

impl Agent for Greeter {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.say("Hello from the community Rust SDK proposal.")?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let app = axum::Router::new().route_agui("/agent", Greeter);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let agent = HttpAgent::new(format!("http://{addr}/agent"))?;
    let mut thread = agent.thread("example-thread");
    let report = thread.send("Hello")?.collect_report().await;
    println!("Outcome: {:?}", report.end);
    println!("Messages: {:?}", report.new_messages);
    server.abort();
    assert!(matches!(report.end, RunEnd::Success { .. }));
    assert!(report.diagnostics.is_empty());
    Ok(())
}
