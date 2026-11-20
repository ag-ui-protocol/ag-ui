//! Incremental, bounded SSE decoding. Network chunk boundaries have no semantic meaning.
use crate::error::AgUiClientError;
use async_trait::async_trait;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest::Response;
use std::pin::Pin;
use std::task::{Context, Poll};

/// A data-bearing SSE frame. Comments and frames without a data field are not events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

/// Limits on unfinished material, independent of network chunk partitioning.
///
/// Defaults allow 16 MiB inline media payloads. A line limit counts UTF-8 bytes before
/// its delimiter; a frame limit counts non-comment lines plus one byte per line.
/// Comments are discarded after each bounded line. There is no parsed-event queue.
#[derive(Debug, Clone, Copy)]
pub struct SseLimits {
    pub max_line_bytes: usize,
    pub max_frame_bytes: usize,
}

impl Default for SseLimits {
    fn default() -> Self {
        Self {
            max_line_bytes: 16 * 1024 * 1024,
            max_frame_bytes: 16 * 1024 * 1024 + 1024,
        }
    }
}

#[async_trait]
pub trait SseResponseExt {
    async fn event_source(
        self,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>>;

    async fn event_source_with_limits(
        self,
        limits: SseLimits,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>>;
}

#[async_trait]
impl SseResponseExt for Response {
    async fn event_source(
        self,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>> {
        self.event_source_with_limits(SseLimits::default()).await
    }

    async fn event_source_with_limits(
        self,
        limits: SseLimits,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>> {
        Box::pin(SseDecoder::new(
            self.bytes_stream().map(|result| result.map_err(Into::into)),
            limits,
        ))
    }
}

/// Converts arbitrary byte chunks into SSE frames, retaining only the current chunk,
/// its offset, and the unfinished line/frame. Dropping this stream drops its source.
///
/// UTF-8 is checked when each complete line is available, never per transport chunk.
/// LF, CRLF and CR are accepted. Only an initial BOM is stripped. A data frame without
/// its blank-line delimiter is an error at EOF, not an implicitly dispatched event.
/// Event IDs/retry fields do not enable reconnect or replay behavior.
pub struct SseDecoder<S> {
    source: Option<Pin<Box<S>>>,
    chunk: Bytes,
    offset: usize,
    limits: SseLimits,
    line: Vec<u8>,
    first_line: bool,
    after_cr: bool,
    frame_bytes: usize,
    pending_frame: bool,
    data_seen: bool,
    data: String,
    event: Option<String>,
    id: Option<String>,
    done: bool,
}

impl<S> SseDecoder<S> {
    pub fn new(source: S, limits: SseLimits) -> Self {
        Self {
            source: Some(Box::pin(source)),
            chunk: Bytes::new(),
            offset: 0,
            limits,
            line: Vec::new(),
            first_line: true,
            after_cr: false,
            frame_bytes: 0,
            pending_frame: false,
            data_seen: false,
            data: String::new(),
            event: None,
            id: None,
            done: false,
        }
    }

    fn finish_line(&mut self) -> Result<Option<SseEvent>, AgUiClientError> {
        let line = std::mem::take(&mut self.line);
        let text = std::str::from_utf8(&line).map_err(|error| AgUiClientError::SseInvalidUtf8 {
            incomplete: error.error_len().is_none(),
        })?;
        let text = if self.first_line {
            self.first_line = false;
            text.strip_prefix('\u{feff}').unwrap_or(text)
        } else {
            text
        };
        let result = if text.is_empty() {
            self.frame_bytes = 0;
            self.pending_frame = false;
            let event = self.data_seen.then(|| SseEvent {
                event: self.event.take(),
                id: self.id.take(),
                data: std::mem::take(&mut self.data),
            });
            self.data_seen = false;
            self.event = None;
            self.id = None;
            event
        } else if text.starts_with(':') {
            None
        } else {
            self.frame_bytes = self.frame_bytes.saturating_add(text.len() + 1);
            if self.frame_bytes > self.limits.max_frame_bytes {
                return Err(AgUiClientError::SseLimitExceeded {
                    kind: "frame",
                    limit: self.limits.max_frame_bytes,
                });
            }
            self.pending_frame = true;
            let (field, value) = text.split_once(':').unwrap_or((text, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "data" => {
                    if self.data_seen {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                    self.data_seen = true;
                }
                "event" => self.event = Some(value.to_owned()),
                "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
                _ => {}
            }
            None
        };
        self.line = line;
        self.line.clear();
        Ok(result)
    }

    fn close(&mut self) {
        self.done = true;
        self.source = None;
        self.chunk = Bytes::new();
        self.line = Vec::new();
        self.data = String::new();
        self.event = None;
        self.id = None;
    }

    fn finish(&mut self) -> Result<(), AgUiClientError> {
        let text =
            std::str::from_utf8(&self.line).map_err(|error| AgUiClientError::SseInvalidUtf8 {
                incomplete: error.error_len().is_none(),
            })?;
        let text = if self.first_line {
            text.strip_prefix('\u{feff}').unwrap_or(text)
        } else {
            text
        };
        if self.pending_frame || (!text.is_empty() && !text.starts_with(':')) {
            return Err(AgUiClientError::SseTruncated);
        }
        Ok(())
    }
}

impl<S> Stream for SseDecoder<S>
where
    S: Stream<Item = Result<Bytes, AgUiClientError>>,
{
    type Item = Result<SseEvent, AgUiClientError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        // Cooperative fairness also bounds work on endless comments/empty chunks.
        let mut budget = 64 * 1024;
        loop {
            if budget == 0 {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            if this.offset == this.chunk.len() {
                budget -= 1;
                match this
                    .source
                    .as_mut()
                    .expect("active source")
                    .as_mut()
                    .poll_next(cx)
                {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Some(Ok(chunk))) => {
                        this.chunk = chunk;
                        this.offset = 0;
                        continue;
                    }
                    Poll::Ready(Some(Err(error))) => {
                        this.close();
                        return Poll::Ready(Some(Err(error)));
                    }
                    Poll::Ready(None) => {
                        let result = this.finish().err().map(Err);
                        this.close();
                        return Poll::Ready(result);
                    }
                }
            }
            budget -= 1;
            let byte = this.chunk[this.offset];
            this.offset += 1;
            if this.after_cr {
                this.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            let result = if matches!(byte, b'\r' | b'\n') {
                this.after_cr = byte == b'\r';
                this.finish_line()
            } else if this.line.len() == this.limits.max_line_bytes {
                Err(AgUiClientError::SseLimitExceeded {
                    kind: "line",
                    limit: this.limits.max_line_bytes,
                })
            } else {
                this.line.push(byte);
                Ok(None)
            };
            match result {
                Ok(Some(event)) => return Poll::Ready(Some(Ok(event))),
                Ok(None) => {}
                Err(error) => {
                    this.close();
                    return Poll::Ready(Some(Err(error)));
                }
            }
        }
    }
}
