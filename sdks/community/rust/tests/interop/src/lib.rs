//! Test-only localhost producer. No application scheduler, storage, or real credentials.
use ag_ui_core::{event::Event, processing::normalize_run_input};
use ag_ui_encoder::{CONTENT_TYPE, Encoder};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const DUMMY_TOKEN: &str = "interop-only-not-a-secret";
const MAX_REQUEST: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub input: Value,
    pub carry_history: bool,
    pub append_messages: Vec<Value>,
    pub expected_request: Value,
    pub expected_effective_state: Value,
    pub response: Vec<Value>,
    pub expected_messages: Vec<Value>,
    pub expected_state: Value,
}

pub fn scenarios() -> BTreeMap<String, Vec<Step>> {
    serde_json::from_str(include_str!("../scenarios.json")).expect("valid scenario manifest")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub request: Value,
    pub raw_request_body: String,
    pub headers: BTreeMap<String, String>,
    pub effective_state: Option<Value>,
    pub diagnostics: Value,
    pub response_events: Vec<Value>,
    pub response_body: String,
    pub admission_error: Option<String>,
}

/// A server has exactly one exchange. Drop always cancels and joins its owned worker.
pub struct FixtureHost {
    pub url: String,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<TestResult<Trace>>>,
}

impl FixtureHost {
    pub fn start(step: Step) -> TestResult<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let url = format!("http://{}/agent", listener.local_addr()?);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if stopped.load(Ordering::Acquire) || Instant::now() > deadline {
                    return Err("fixture host cancelled or no request within 30 seconds".into());
                }
                match listener.accept() {
                    Ok((stream, _)) => return serve(stream, &step),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        });
        Ok(Self {
            url,
            stop,
            worker: Some(worker),
        })
    }

    pub fn finish(mut self) -> TestResult<Trace> {
        self.worker
            .take()
            .expect("one join")
            .join()
            .map_err(|_| "fixture host panicked")?
    }
}

impl Drop for FixtureHost {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn read_line(reader: &mut BufReader<TcpStream>, remaining: &mut usize) -> TestResult<String> {
    let mut bytes = Vec::new();
    reader
        .take((*remaining + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() || bytes.len() > *remaining || !bytes.ends_with(b"\r\n") {
        return Err("truncated, oversized, or malformed HTTP request line".into());
    }
    *remaining -= bytes.len();
    Ok(String::from_utf8(bytes[..bytes.len() - 2].to_vec())?)
}

fn read_request(stream: &TcpStream) -> TestResult<(BTreeMap<String, String>, String)> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut remaining = MAX_REQUEST;
    if read_line(&mut reader, &mut remaining)? != "POST /agent HTTP/1.1" {
        return Err("fixture requires POST /agent HTTP/1.1".into());
    }
    let mut headers = BTreeMap::new();
    loop {
        let line = read_line(&mut reader, &mut remaining)?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or("malformed HTTP header")?;
        if headers
            .insert(name.to_ascii_lowercase(), value.trim().to_owned())
            .is_some()
        {
            return Err("duplicate HTTP request header".into());
        }
    }
    let mut body = Vec::new();
    match (
        headers.get("content-length"),
        headers.get("transfer-encoding"),
    ) {
        (Some(length), None) => {
            let length: usize = length.parse()?;
            if length > remaining {
                return Err("request body limit".into());
            }
            body.resize(length, 0);
            reader.read_exact(&mut body)?;
        }
        (None, Some(encoding)) if encoding.eq_ignore_ascii_case("chunked") => loop {
            let line = read_line(&mut reader, &mut remaining)?;
            let size = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)?;
            if size == 0 {
                // Bounded, well-formed trailers; they never alter captured headers.
                while !read_line(&mut reader, &mut remaining)?.is_empty() {}
                break;
            }
            if size > remaining {
                return Err("chunked request body limit".into());
            }
            remaining -= size;
            let offset = body.len();
            body.resize(offset + size, 0);
            reader.read_exact(&mut body[offset..])?;
            if !read_line(&mut reader, &mut remaining)?.is_empty() {
                return Err("invalid HTTP chunk delimiter".into());
            }
        },
        _ => return Err("require unambiguous Content-Length or chunked body framing".into()),
    }
    Ok((headers, String::from_utf8(body)?))
}

fn reject(stream: &mut TcpStream, status: &str, message: &str) -> TestResult<()> {
    let body = serde_json::to_vec(&json!({"error": message}))?;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)?;
    Ok(())
}

fn serve(mut stream: TcpStream, step: &Step) -> TestResult<Trace> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let (headers, raw_request_body) = read_request(&stream)?;
    let request: Value = serde_json::from_str(&raw_request_body)?;
    if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {DUMMY_TOKEN}")) {
        reject(
            &mut stream,
            "401 Unauthorized",
            "dummy fixture bearer required",
        )?;
        return Err("dummy fixture authentication not sent".into());
    }
    if headers.get("accept").map(String::as_str) != Some("text/event-stream")
        || headers.get("content-type").map(String::as_str) != Some("application/json")
    {
        reject(
            &mut stream,
            "406 Not Acceptable",
            "JSON input and SSE Accept required",
        )?;
        return Err("missing JSON/SSE negotiation headers".into());
    }
    // Admission, including unsupported-major rejection, happens before SSE success headers.
    let processed = match normalize_run_input(request.clone()) {
        Ok(input) => input,
        Err(error) => {
            let message = error.to_string();
            reject(&mut stream, "422 Unprocessable Entity", &message)?;
            return Ok(Trace {
                request,
                raw_request_body,
                headers,
                effective_state: None,
                diagnostics: json!([]),
                response_events: vec![],
                response_body: String::new(),
                admission_error: Some(message),
            });
        }
    };
    if request != step.expected_request
        || processed.effective_state != step.expected_effective_state
    {
        reject(
            &mut stream,
            "409 Conflict",
            "captured request differs from authored fixture",
        )?;
        return Err(format!(
            "request mismatch\nactual: {request}\nexpected: {}\neffective: {}",
            step.expected_request, processed.effective_state
        )
        .into());
    }
    let encoder = Encoder::default();
    let mut bytes = encoder.keepalive("fixture heartbeat 🌍")?;
    let mut response_events = Vec::new();
    for source in &step.response {
        let event: Event = serde_json::from_value(source.clone())?;
        let encoded = encoder.encode_live(&event)?;
        if encoded.contains(&b'\r') || !encoded.ends_with(b"\n\n") {
            return Err("encoder violated LF-only SSE framing".into());
        }
        let framed = std::str::from_utf8(&encoded)?;
        let data = framed
            .strip_prefix("data: ")
            .or_else(|| framed.strip_prefix("data:"))
            .ok_or("encoder did not produce a data field")?
            .trim();
        response_events.push(serde_json::from_str::<Value>(data)?);
        bytes.extend(encoded);
        bytes.extend(encoder.keepalive("between events")?);
    }
    // Deliberately fragmented socket writes complement, but never substitute for,
    // the client's deterministic every-byte-partition decoder unit tests.
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: {CONTENT_TYPE}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    for chunk in bytes.chunks(7) {
        stream.write_all(chunk)?;
    }
    stream.flush()?;
    Ok(Trace {
        request,
        raw_request_body,
        headers,
        effective_state: Some(processed.effective_state),
        diagnostics: serde_json::to_value(processed.diagnostics)?,
        response_events,
        response_body: String::from_utf8(bytes)?,
        admission_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_rejects_unsupported_major_and_malformed_known_input_before_sse() -> TestResult<()>
    {
        for mutation in [json!({"protocolVersion":"2.0"}), json!({"messages":7})] {
            let step = scenarios()["ordinary"][0].clone();
            let mut input = step.expected_request.clone();
            input
                .as_object_mut()
                .unwrap()
                .extend(mutation.as_object().unwrap().clone());
            let host = FixtureHost::start(step)?;
            let addr = host
                .url
                .strip_prefix("http://")
                .unwrap()
                .strip_suffix("/agent")
                .unwrap();
            let mut stream = TcpStream::connect(addr)?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            let body = serde_json::to_vec(&input)?;
            write!(
                stream,
                "POST /agent HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {DUMMY_TOKEN}\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )?;
            stream.write_all(&body)?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            let trace = host.finish()?;
            assert!(response.starts_with("HTTP/1.1 422 "));
            assert!(!response.contains("text/event-stream"));
            assert!(!response.contains("RUN_STARTED"));
            assert!(trace.admission_error.is_some());
            assert!(trace.response_events.is_empty());
        }
        Ok(())
    }

    #[test]
    fn chunked_request_capture_reads_complete_json_body() -> TestResult<()> {
        let step = scenarios()["ordinary"][0].clone();
        let body = serde_json::to_vec(&step.expected_request)?;
        let host = FixtureHost::start(step.clone())?;
        let addr = host
            .url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/agent")
            .unwrap();
        let mut stream = TcpStream::connect(addr)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        write!(
            stream,
            "POST /agent HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {DUMMY_TOKEN}\r\nContent-Type: application/json\r\nAccept: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
        )?;
        for chunk in body.chunks(13) {
            write!(stream, "{:x}\r\n", chunk.len())?;
            stream.write_all(chunk)?;
            stream.write_all(b"\r\n")?;
        }
        stream.write_all(b"0\r\nX-Fixture-Trailer: ignored\r\n\r\n")?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        assert!(response.starts_with("HTTP/1.1 200 "));
        let trace = host.finish()?;
        assert_eq!(trace.request, step.expected_request);
        assert_eq!(trace.raw_request_body.as_bytes(), body);
        Ok(())
    }
}
