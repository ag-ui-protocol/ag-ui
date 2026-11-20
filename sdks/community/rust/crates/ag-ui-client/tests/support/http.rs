//! Bounded HTTP/1 request capture, including bodies split after the headers.
use std::collections::BTreeMap;
use std::time::Duration;

pub const TEST_TIMEOUT: Duration = Duration::from_secs(10);
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug)]
pub struct Request {
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub fn parse(bytes: &[u8]) -> Result<Option<Request>, String> {
    let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") else {
        return Ok(None);
    };
    let header = std::str::from_utf8(&bytes[..end]).map_err(|error| error.to_string())?;
    let mut lines = header.split("\r\n");
    let request_line = lines.next().ok_or("missing request line")?;
    if !request_line.starts_with("POST ") {
        return Err("expected POST request".into());
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let (key, value) = line.split_once(':').ok_or("malformed request header")?;
        if headers
            .insert(key.trim().to_ascii_lowercase(), value.trim().to_string())
            .is_some()
        {
            return Err("duplicate request header".into());
        }
    }
    let input = &bytes[end + 4..];
    let body = if let Some(encoding) = headers.get("transfer-encoding") {
        if !encoding.eq_ignore_ascii_case("chunked") {
            return Err("unsupported request transfer encoding".into());
        }
        if headers.contains_key("content-length") {
            return Err("ambiguous request framing".into());
        }
        let mut output = Vec::new();
        let mut cursor = 0;
        loop {
            let Some(line_len) = input[cursor..].windows(2).position(|s| s == b"\r\n") else {
                return Ok(None);
            };
            let line = std::str::from_utf8(&input[cursor..cursor + line_len])
                .map_err(|error| error.to_string())?;
            let size = usize::from_str_radix(line.split(';').next().unwrap(), 16)
                .map_err(|error| error.to_string())?;
            cursor += line_len + 2;
            if size == 0 {
                // A zero chunk is followed by a possibly empty trailer section.
                if input.get(cursor..cursor + 2) == Some(b"\r\n") {
                    break;
                }
                if input[cursor..].windows(4).any(|s| s == b"\r\n\r\n") {
                    break;
                }
                return Ok(None);
            }
            let next = cursor.checked_add(size).ok_or("chunk length overflow")?;
            let terminator = next.checked_add(2).ok_or("chunk length overflow")?;
            if input.len() < terminator {
                return Ok(None);
            }
            if &input[next..terminator] != b"\r\n" {
                return Err("bad chunk delimiter".into());
            }
            output.extend_from_slice(&input[cursor..next]);
            cursor = terminator;
        }
        output
    } else {
        let size = headers
            .get("content-length")
            .ok_or("missing request length")?
            .parse::<usize>()
            .map_err(|error| error.to_string())?;
        if input.len() < size {
            return Ok(None);
        }
        input[..size].to_vec()
    };
    Ok(Some(Request { headers, body }))
}

pub async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Request, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        if let Some(request) = parse(&bytes)? {
            return Ok(request);
        }
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if n == 0 {
            return Err("request ended before its complete body".into());
        }
        bytes.extend_from_slice(&buffer[..n]);
        if bytes.len() > 1024 * 1024 {
            return Err("fixture request exceeded capture bound".into());
        }
    }
}
