//! Decoding `text/event-stream`.
//!
//! The encoder lives in `ag_ui::encode`; this is the other half. It is a wire
//! format parser fed by a network, so it assumes nothing about what it is
//! handed: bytes arrive in arbitrary chunks that split lines, split UTF-8
//! sequences, and end without the terminating blank line the format calls for.
//!
//! What it handles, because real servers and proxies do all of it:
//!
//! - `data:` repeated over several lines, rejoined with `\n` — the format's own
//!   way of carrying a payload that contains newlines.
//! - Comment lines (`: keep-alive`), which proxies inject to hold a connection
//!   open and which dispatch nothing.
//! - A body that ends without a blank line: [`SseDecoder::finish`] dispatches
//!   the last frame rather than dropping it.
//! - `\n`, `\r\n` and lone `\r` line endings, including a `\r\n` split across
//!   two chunks.
//! - A leading UTF-8 byte-order mark.
//! - A field with no colon, an empty field value, and unknown field names.
//! - A frame with no `data` field, which the format says not to dispatch.
//!
//! What it refuses: invalid UTF-8, and a single frame larger than
//! [`SseDecoder::max_frame_size`] — an unterminated line is otherwise an
//! unbounded allocation driven by the other end. The cap is on the frame, not
//! on the chunk: one read carrying a thousand complete frames is ordinary, and
//! counting it against a per-frame limit would refuse a well-behaved server.
//!
//! ```
//! use ag_ui::client::transport::SseDecoder;
//!
//! let mut decoder = SseDecoder::new();
//! decoder.push(b": keep-alive\n\ndata: {\"type\":\"RUN_ERROR\",\"mes")?;
//! assert!(decoder.next_frame()?.is_none());
//!
//! decoder.push(b"sage\":\"boom\"}\n\n")?;
//! let frame = decoder.next_frame()?.expect("a complete frame");
//! assert_eq!(frame.into_event()?.event_type().as_str(), "RUN_ERROR");
//! # Ok::<(), ag_ui::client::Error>(())
//! ```

use std::collections::VecDeque;

use crate::Event;
use futures_core::Stream;
use futures_util::StreamExt;

use crate::client::error::{Error, Result};

/// The default cap on one frame, before the decoder gives up: 8 MiB.
pub const DEFAULT_MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;

/// One decoded `text/event-stream` frame.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseFrame {
    /// The `event:` field, if the server sent one. AG-UI does not use it.
    pub event: Option<String>,
    /// The `data:` field, with the trailing newline removed and multiple
    /// `data:` lines rejoined with `\n`.
    pub data: String,
    /// The `id:` field, if the server sent one.
    pub id: Option<String>,
    /// The `retry:` field, in milliseconds, if the server sent one.
    pub retry: Option<u64>,
}

impl SseFrame {
    /// Parses the frame's payload as an AG-UI event.
    pub fn into_event(self) -> Result<Event> {
        serde_json::from_str(&self.data).map_err(Error::from)
    }
}

/// An incremental `text/event-stream` decoder.
///
/// Push bytes, pull frames. It owns a buffer for the partial line at the end of
/// each chunk, which is why it has to be a struct and not a function.
#[derive(Clone, Debug)]
pub struct SseDecoder {
    buffer: Vec<u8>,
    /// How much of `buffer` has already been handed out as lines.
    ///
    /// The consumed prefix is dropped on the next push rather than as each line
    /// is taken: shifting the remainder once per read instead of once per line
    /// is what keeps a chunk carrying a thousand frames linear.
    consumed: usize,
    data: String,
    event: Option<String>,
    id: Option<String>,
    retry: Option<u64>,
    max_frame_size: usize,
    at_start: bool,
}

impl Default for SseDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl SseDecoder {
    /// A decoder with the default frame size cap.
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            consumed: 0,
            data: String::new(),
            event: None,
            id: None,
            retry: None,
            max_frame_size: DEFAULT_MAX_FRAME_SIZE,
            at_start: true,
        }
    }

    /// Sets the cap on a single frame.
    #[must_use]
    pub fn with_max_frame_size(mut self, bytes: usize) -> Self {
        self.max_frame_size = bytes;
        self
    }

    /// The cap on a single frame, in bytes.
    pub fn max_frame_size(&self) -> usize {
        self.max_frame_size
    }

    /// Feeds the decoder a chunk of the response body.
    ///
    /// # Errors
    ///
    /// [`Error::Decode`] when the frame being assembled exceeds
    /// [`SseDecoder::max_frame_size`] — a server that never sends a line break
    /// would otherwise grow this buffer without bound.
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if self.consumed > 0 {
            self.buffer.drain(..self.consumed);
            self.consumed = 0;
        }
        self.buffer.extend_from_slice(bytes);
        self.check_frame_size()
    }

    /// The bytes pushed but not yet handed out as lines.
    fn pending(&self) -> &[u8] {
        &self.buffer[self.consumed..]
    }

    /// Checks the frame under construction against the cap.
    ///
    /// What counts is the payload accumulated so far plus the bytes that cannot
    /// yet *become* a line — everything up to the last line terminator is a
    /// complete line [`next_frame`](Self::next_frame) will drain, so it does
    /// not. The cap is on one frame, not on how much a transport happens to
    /// hand over at once: a single 1 MiB chunk of complete frames is ordinary,
    /// and rejecting it would break a perfectly well-behaved server.
    fn check_frame_size(&self) -> Result<()> {
        let pending = self.pending();
        let unterminated = match pending.iter().rposition(|b| *b == b'\n' || *b == b'\r') {
            Some(position) => pending.len() - position - 1,
            None => pending.len(),
        };
        if unterminated + self.data.len() > self.max_frame_size {
            return Err(Error::decode(format!(
                "frame exceeded the {} byte limit before a line break",
                self.max_frame_size
            )));
        }
        Ok(())
    }

    /// Pulls the next complete frame, if the bytes pushed so far contain one.
    ///
    /// # Errors
    ///
    /// [`Error::Decode`] when the bytes are not UTF-8.
    pub fn next_frame(&mut self) -> Result<Option<SseFrame>> {
        while let Some(line) = self.take_line(false)? {
            if let Some(frame) = self.process(&line) {
                return Ok(Some(frame));
            }
            // A frame made of ten million `data:` lines never reaches
            // [`push`]'s check, because every one of them is terminated.
            if self.data.len() > self.max_frame_size {
                return Err(Error::decode(format!(
                    "frame exceeded the {} byte limit across its data lines",
                    self.max_frame_size
                )));
            }
        }
        Ok(None)
    }

    /// Drains the decoder at the end of the stream.
    ///
    /// A body that stops without the blank line that terminates its last frame
    /// is common enough — a closed connection, a server that forgets — that
    /// dropping the frame would lose real events. Anything still buffered is
    /// dispatched here.
    ///
    /// # Errors
    ///
    /// [`Error::Decode`] when the trailing bytes are not UTF-8.
    pub fn finish(&mut self) -> Result<Vec<SseFrame>> {
        let mut frames = Vec::new();
        while let Some(line) = self.take_line(true)? {
            if let Some(frame) = self.process(&line) {
                frames.push(frame);
            }
        }
        if let Some(frame) = self.dispatch() {
            frames.push(frame);
        }
        Ok(frames)
    }

    /// Takes one complete line, minus its terminator.
    ///
    /// At `eof` the trailing bytes count as a line even without a terminator.
    /// Otherwise a `\r` at the very end of the buffer is held back: it may yet
    /// turn out to be the first half of a `\r\n` split across two chunks.
    fn take_line(&mut self, eof: bool) -> Result<Option<String>> {
        let pending = self.pending();
        let Some(position) = pending.iter().position(|b| *b == b'\n' || *b == b'\r') else {
            if eof && !pending.is_empty() {
                let line = pending.to_vec();
                self.consumed = self.buffer.len();
                return self.decode_line(line).map(Some);
            }
            return Ok(None);
        };

        let is_cr = pending[position] == b'\r';
        if is_cr && position + 1 == pending.len() && !eof {
            return Ok(None);
        }

        let width = if is_cr && pending.get(position + 1) == Some(&b'\n') {
            2
        } else {
            1
        };
        let line = pending[..position].to_vec();
        self.consumed += position + width;
        self.decode_line(line).map(Some)
    }

    fn decode_line(&mut self, line: Vec<u8>) -> Result<String> {
        let mut line = String::from_utf8(line)
            .map_err(|error| Error::decode(format!("stream is not UTF-8: {error}")))?;
        if self.at_start {
            self.at_start = false;
            if let Some(stripped) = line.strip_prefix('\u{feff}') {
                line = stripped.to_owned();
            }
        }
        Ok(line)
    }

    /// Applies one line to the frame being built, dispatching on a blank line.
    fn process(&mut self, line: &str) -> Option<SseFrame> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            // A comment. Heartbeats are the usual reason one is here.
            return None;
        }

        let (field, value) = match line.find(':') {
            Some(index) => (&line[..index], strip_one_space(&line[index + 1..])),
            // A field name with no colon has an empty value.
            None => (line, ""),
        };

        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event = Some(value.to_owned()),
            "id" => self.id = Some(value.to_owned()),
            "retry" => {
                if let Ok(milliseconds) = value.parse() {
                    self.retry = Some(milliseconds);
                }
            }
            // Unknown fields are ignored, as the format requires.
            _ => {}
        }
        None
    }

    /// Emits the buffered frame, if it has a payload.
    fn dispatch(&mut self) -> Option<SseFrame> {
        let event = self.event.take();
        let id = self.id.take();
        let retry = self.retry.take();
        let mut data = std::mem::take(&mut self.data);
        if data.is_empty() {
            // No data field: the format says this dispatches nothing. A frame
            // of pure comments or a stray blank line lands here.
            return None;
        }
        data.pop();
        Some(SseFrame {
            event,
            data,
            id,
            retry,
        })
    }
}

/// Removes the single optional space after a field's colon.
fn strip_one_space(value: &str) -> &str {
    value.strip_prefix(' ').unwrap_or(value)
}

/// Decodes a stream of byte chunks into a stream of events.
///
/// This is the adapter between a transport's body stream and the rest of the
/// crate. Errors from the byte stream become [`Error::Transport`] items and end
/// the stream; a frame whose payload is not a valid event becomes an error item
/// and the stream continues, because one malformed event should not silence the
/// rest of the run.
pub fn decode_events<S, B, E>(chunks: S) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = core::result::Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::error::Error + Send + Sync + 'static,
{
    let state = Decoding {
        chunks: Box::pin(chunks),
        decoder: SseDecoder::new(),
        ready: VecDeque::new(),
        done: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(item) = state.ready.pop_front() {
                return Some((item, state));
            }
            if state.done {
                return None;
            }

            match state.chunks.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) = state.decoder.push(bytes.as_ref()) {
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    loop {
                        match state.decoder.next_frame() {
                            Ok(Some(frame)) => state.ready.push_back(frame.into_event()),
                            Ok(None) => break,
                            Err(error) => {
                                state.done = true;
                                state.ready.push_back(Err(error));
                                break;
                            }
                        }
                    }
                }
                Some(Err(error)) => {
                    state.done = true;
                    return Some((Err(Error::transport(error)), state));
                }
                None => {
                    state.done = true;
                    match state.decoder.finish() {
                        Ok(frames) => state
                            .ready
                            .extend(frames.into_iter().map(SseFrame::into_event)),
                        Err(error) => state.ready.push_back(Err(error)),
                    }
                }
            }
        }
    })
}

/// The state [`decode_events`] carries between polls.
struct Decoding<S> {
    chunks: std::pin::Pin<Box<S>>,
    decoder: SseDecoder,
    ready: VecDeque<Result<Event>>,
    done: bool,
}

#[cfg(test)]
mod tests {
    use super::SseDecoder;

    /// A body of `frames` identical two-line frames, and the size of one.
    fn body(frames: usize) -> (String, usize) {
        let frame = "data: {\"type\":\"CUSTOM\"}\n\n";
        (frame.repeat(frames), frame.len())
    }

    #[test]
    fn taking_a_line_moves_the_cursor_instead_of_the_bytes_behind_it() {
        // `take_line` used to `split_off` the remainder of the buffer, copying
        // every byte still unread once per line. One read carrying a thousand
        // frames — a fast agent filling a TCP window — then cost a thousand
        // copies of a shrinking buffer, and the total grew with the square of
        // the frame count. The cursor is what makes it linear, and the buffer
        // holding still while frames come out of it is how that is visible
        // without timing anything.
        let (body, frame_size) = body(64);
        let mut decoder = SseDecoder::new();
        decoder.push(body.as_bytes()).expect("pushes");
        let pushed = decoder.buffer.len();

        for taken in 1..=32 {
            decoder
                .next_frame()
                .expect("decodes")
                .expect("64 frames went in");
            assert_eq!(
                decoder.buffer.len(),
                pushed,
                "the unread remainder was recopied after {taken} frames"
            );
            assert_eq!(decoder.consumed, taken * frame_size);
        }

        // The consumed prefix is dropped once, on the next push, rather than
        // once per line.
        decoder.push(b"data: x\n\n").expect("pushes");
        assert_eq!(decoder.consumed, 0);
        assert_eq!(decoder.buffer.len(), pushed - 32 * frame_size + 9);
    }

    #[test]
    fn dropping_the_consumed_prefix_does_not_disturb_what_is_still_buffered() {
        // That drop rewrites the offset every remaining byte sits at, so the
        // frames either side of a push have to come out whole and in order.
        let (body, _) = body(4);
        let mut decoder = SseDecoder::new();
        decoder.push(body.as_bytes()).expect("pushes");
        decoder.next_frame().expect("decodes").expect("a frame");
        decoder.next_frame().expect("decodes").expect("a frame");

        decoder.push(b"data: last\n\n").expect("pushes");
        let mut rest = Vec::new();
        while let Some(frame) = decoder.next_frame().expect("decodes") {
            rest.push(frame.data);
        }
        assert_eq!(
            rest,
            [r#"{"type":"CUSTOM"}"#, r#"{"type":"CUSTOM"}"#, "last"]
        );
    }
}
