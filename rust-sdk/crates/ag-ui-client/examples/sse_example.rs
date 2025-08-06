use ag_ui_client::sse::SseResponseExt;
use ag_ui_core::event::Event;
use futures::StreamExt;
use serde::Deserialize;
use std::error::Error;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EventType {
    Ping,
    Update,
    Message,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Create a client
    let client = reqwest::Client::new();

    // Example 1: Stream with custom event and data types
    println!("Example 1: Typed events with custom event and data types");
    let response = client.get("https://httpbun.org/sse").send().await?;
    let mut stream = response.event_source().await;

    while let Some(result) = stream.next().await {
        match result {
            Ok(sse_event) => {
                if let Some(event_type) = &sse_event.event {
                    match event_type.as_str() {
                        "ping" => println!("Ping: {}", sse_event.data),
                        &_ => panic!("Unknown event type {event_type}"),
                    }
                }
            }
            Err(err) => eprintln!("Error: {}", err),
        }
    }
    Ok(())
}
