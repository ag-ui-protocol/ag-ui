use crate::error::AgUiClientError;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest::Response;
use std::future::Future;

/// Represents a parsed Server-Sent Event
#[derive(Debug)]
pub struct SseEvent {
    /// The event type (from the "event:" field)
    pub event: Option<String>,

    /// The event ID (from the "id:" field)
    pub id: Option<String>,

    /// The event data (from the "data:" field)
    pub data: String,
}

/// Extension trait for processing Server-Sent Events (SSE) responses from reqwest::Response
///
/// This trait provides methods to process SSE responses as a stream of events with customizable
/// type parameters for event type, data, and id fields.
///
/// # SSE Format
///
/// Server-Sent Events typically follow this format:
/// ```text
/// event: ping
/// id: 1
/// data: {"message": "hello"}
///
/// event: update
/// id: 2
/// data: {"id": 123, "status": "ok"}
/// ```
///
/// Where:
/// - `event`: Optional field specifying the event type
/// - `id`: Optional field providing an event identifier
/// - `data`: The event payload, often JSON data
///
/// Events are separated by double newlines (`\n\n`).
pub trait SseResponseExt {
    /// Converts a reqwest::Response into a Stream of SSE events
    fn event_source(
        self,
    ) -> impl Future<Output = impl Stream<Item = Result<SseEvent, AgUiClientError>>> + Send;
}

impl SseResponseExt for Response {
    #[allow(clippy::manual_async_fn)]
    fn event_source(
        self,
    ) -> impl Future<Output = impl Stream<Item = Result<SseEvent, AgUiClientError>>> + Send {
        async move {
            // Create a stream of bytes from the response
            let stream = self.bytes_stream();

            // Process the stream with type conversions
            SseEventProcessor::new(stream)
        }
    }
}

/// A processor that converts a byte stream into an SSE event stream
struct SseEventProcessor;

impl SseEventProcessor {
    /// Creates a new SSE event processor
    #[allow(clippy::new_ret_no_self)]
    fn new(
        stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + 'static,
    ) -> impl Stream<Item = Result<SseEvent, AgUiClientError>> {
        let mut buffer = String::new();

        // Process the stream
        stream
            .map(move |chunk_result| {
                // Map reqwest errors
                let chunk = match chunk_result {
                    Ok(chunk) => chunk,
                    Err(err) => return vec![Err(AgUiClientError::HttpTransport(err))],
                };

                // Convert bytes to string and append to buffer
                match String::from_utf8(chunk.to_vec()) {
                    Ok(text) => {
                        buffer.push_str(&text);

                        // Process complete events from the buffer
                        let (events, new_buffer) = process_raw_sse_events(&buffer);
                        buffer = new_buffer;

                        events
                    }
                    Err(e) => vec![Err(AgUiClientError::SseParse {
                        message: format!("Invalid UTF-8: {e}"),
                    })],
                }
            })
            .flat_map(futures::stream::iter)
    }
}

/// Process SSE data from a buffer string into raw SSE events
///
/// Returns a tuple of (events, new_buffer) where:
/// - events: A vector of parsed events or errors
/// - new_buffer: The remaining buffer that might contain incomplete events
fn process_raw_sse_events(buffer: &str) -> (Vec<Result<SseEvent, AgUiClientError>>, String) {
    let mut results = Vec::new();
    let chunks: Vec<&str> = buffer.split("\n\n").collect();

    // If there's only one chunk and it doesn't end with a double newline,
    // it might be incomplete - keep it in the buffer
    if chunks.len() == 1 && !buffer.ends_with("\n\n") {
        return (Vec::new(), buffer.to_string());
    }

    let complete_chunks = if buffer.ends_with("\n\n") {
        // All chunks are complete
        &chunks[..]
    } else {
        // Last chunk might be incomplete
        &chunks[..chunks.len() - 1]
    };

    // Process all complete events
    for chunk in complete_chunks {
        if !chunk.is_empty() {
            results.push(parse_sse_event(chunk));
        }
    }

    // If the buffer doesn't end with a double newline and we have chunks,
    // the last chunk is incomplete - keep it in the buffer
    let new_buffer = if !buffer.ends_with("\n\n") && !chunks.is_empty() {
        chunks.last().unwrap().to_string()
    } else {
        String::new()
    };

    (results, new_buffer)
}

/// Parse a single SSE event text into an SseEvent
fn parse_sse_event(event_text: &str) -> Result<SseEvent, AgUiClientError> {
    let mut event = None;
    let mut id = None;
    let mut data_lines = Vec::new();

    for line in event_text.lines() {
        if line.is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            // For data lines, trim a leading space if present
            let data_content = value.strip_prefix(" ").unwrap_or(value);
            data_lines.push(data_content);
        }
        // Ignore other fields like "retry:"
    }

    // Join all data lines with newlines
    let data = data_lines.join("\n");

    Ok(SseEvent { event, id, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize, Debug, PartialEq)]
    struct TestEvent {
        event_type: String,
        data: String,
    }

    #[tokio::test]
    async fn test_process_raw_sse_events() {
        // Test with a single complete event
        let buffer = "data: {\"event_type\":\"test\",\"data\":\"hello\"}\n\n";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(new_buffer, "");
        let event = events[0].as_ref().unwrap();
        assert_eq!(event.data, "{\"event_type\":\"test\",\"data\":\"hello\"}");

        // Test with multiple events
        let buffer = "data: {\"event_type\":\"test1\",\"data\":\"hello1\"}\n\n\
                      data: {\"event_type\":\"test2\",\"data\":\"hello2\"}\n\n";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(new_buffer, "");

        // Test with incomplete event
        let buffer = "data: {\"event_type\":\"test\",\"data\":\"hello\"}";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 0);
        assert_eq!(new_buffer, buffer);

        // Test with complete and incomplete events
        let buffer = "data: {\"event_type\":\"test1\",\"data\":\"hello1\"}\n\n\
                      data: {\"event_type\":\"test2\",\"data\":\"hello2\"}";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(
            new_buffer,
            "data: {\"event_type\":\"test2\",\"data\":\"hello2\"}"
        );
    }

    #[tokio::test]
    async fn test_parse_sse_event() {
        // Test with event and data
        let event_text = "event: ping\ndata: {\"message\":\"hello\"}";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("ping".to_string()));
        assert_eq!(sse_event.id, None);
        assert_eq!(sse_event.data, "{\"message\":\"hello\"}");

        // Test with event, id, and data
        let event_text = "event: update\nid: 123\ndata: {\"status\":\"ok\"}";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("update".to_string()));
        assert_eq!(sse_event.id, Some("123".to_string()));
        assert_eq!(sse_event.data, "{\"status\":\"ok\"}");

        // Test with multi-line data
        let event_text = "event: message\ndata: line 1\ndata: line 2\ndata: line 3";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("message".to_string()));
        assert_eq!(sse_event.data, "line 1\nline 2\nline 3");
    }

    #[tokio::test]
    async fn test_different_event_types() {
        // Define different data structures for different event types
        #[derive(Deserialize, Debug, PartialEq)]
        struct PingData {
            message: String,
        }

        #[derive(Deserialize, Debug, PartialEq)]
        struct UpdateData {
            id: u32,
            status: String,
        }

        // Create a buffer with different event types
        let buffer = "event: ping\ndata: {\"message\":\"hello\"}\n\n\
                      event: update\ndata: {\"id\":123,\"status\":\"ok\"}\n\n";

        // Process the raw events
        let (raw_events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(raw_events.len(), 2);
        assert_eq!(new_buffer, "");

        // Process each event based on its type
        let ping_event = raw_events[0].as_ref().unwrap();
        let update_event = raw_events[1].as_ref().unwrap();

        assert_eq!(ping_event.event, Some("ping".to_string()));
        assert_eq!(update_event.event, Some("update".to_string()));

        // Deserialize the ping event
        let ping_data: PingData = serde_json::from_str(&ping_event.data).unwrap();
        assert_eq!(
            ping_data,
            PingData {
                message: "hello".to_string()
            }
        );

        // Deserialize the update event
        let update_data: UpdateData = serde_json::from_str(&update_event.data).unwrap();
        assert_eq!(
            update_data,
            UpdateData {
                id: 123,
                status: "ok".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_enum_event_types() {
        // Define an enum for event types
        #[derive(Deserialize, Debug, PartialEq)]
        #[serde(rename_all = "lowercase")]
        enum EventType {
            Ping,
            Update,
            Message,
        }

        // Define a data structure
        #[derive(Deserialize, Debug, PartialEq)]
        struct EventData {
            value: String,
        }

        // Test direct deserialization with stream_with_types
        let buffer = "event: ping\ndata: {\"value\":\"ping data\"}\n\n\
                      event: update\ndata: {\"value\":\"update data\"}\n\n\
                      event: message\ndata: {\"value\":\"message data\"}\n\n";

        // Process the raw events
        let (raw_events, _) = process_raw_sse_events(buffer);
        assert_eq!(raw_events.len(), 3);

        // Parse event types as enum values
        for raw_event in raw_events {
            let sse_event = raw_event.unwrap();
            let event_type: EventType =
                serde_json::from_str(&format!("\"{}\"", sse_event.event.unwrap())).unwrap();
            let data: EventData = serde_json::from_str(&sse_event.data).unwrap();

            // Verify the event type matches the expected enum variant
            match event_type {
                EventType::Ping => assert_eq!(data.value, "ping data"),
                EventType::Update => assert_eq!(data.value, "update data"),
                EventType::Message => assert_eq!(data.value, "message data"),
            }
        }
    }
}
