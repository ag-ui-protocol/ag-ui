#[path = "support/http.rs"]
mod http;

#[cfg(test)]
mod tests {
    use super::http::*;

    #[test]
    fn content_length_waits_for_full_body_at_every_split() {
        let raw = b"POST / HTTP/1.1\r\nContent-Length: 7\r\nContent-Type: application/json\r\n\r\n{\"x\":1}";
        for split in 0..raw.len() {
            assert!(parse(&raw[..split]).unwrap().is_none(), "split {split}");
        }
        let result = parse(raw).unwrap().unwrap();
        assert_eq!(result.body, b"{\"x\":1}");
        assert_eq!(result.headers["content-type"], "application/json");
    }

    #[test]
    fn chunked_body_waits_for_terminator_and_preserves_payload() {
        let raw = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;test=yes\r\n{\"x\r\n4\r\n\":1}\r\n0\r\nX-Test: yes\r\n\r\n";
        for split in 0..raw.len() {
            assert!(parse(&raw[..split]).unwrap().is_none(), "split {split}");
        }
        assert_eq!(parse(raw).unwrap().unwrap().body, b"{\"x\":1}");
        assert!(
            parse(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n")
                .is_err()
        );
    }
}

#[tokio::test]
async fn request_capture_rejects_incomplete_eof_and_bounds_open_incomplete_requests() {
    use tokio::io::AsyncWriteExt;
    for bytes in [
        b"POST / HTTP/1.1\r\nContent-Length: 5\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n{",
        b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{",
    ] {
        let mut eof = bytes;
        assert_eq!(
            tokio::time::timeout(http::TEST_TIMEOUT, http::read(&mut eof))
                .await
                .unwrap()
                .unwrap_err(),
            "request ended before its complete body"
        );
        let (mut writer, mut reader) = tokio::io::duplex(256);
        writer.write_all(bytes).await.unwrap();
        // The writer remains open: lack of progress must meet a deadline.
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                http::read(&mut reader)
            )
            .await
            .is_err()
        );
        drop(writer);
        assert_eq!(
            tokio::time::timeout(http::TEST_TIMEOUT, http::read(&mut reader))
                .await
                .unwrap()
                .unwrap_err(),
            "request ended before its complete body"
        );
    }
}

#[tokio::test]
async fn fixture_deadlines_bound_stalled_accept_and_response_writes() {
    use tokio::io::AsyncWriteExt;
    let deadline = std::time::Duration::from_millis(20);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    assert!(
        tokio::time::timeout(deadline, listener.accept())
            .await
            .is_err()
    );
    let (mut response, _unread_client) = tokio::io::duplex(1);
    assert!(
        tokio::time::timeout(deadline, response.write_all(b"HTTP/1.1 200 OK\r\n\r\nbody"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn capture_rejects_duplicate_headers_bad_chunks_and_excessive_requests() {
    use tokio::io::AsyncWriteExt;
    for raw in [
        b"POST / HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx!!",
        b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n",
    ] {
        assert!(http::parse(raw).is_err());
    }
    let (mut writer, mut reader) = tokio::io::duplex(2 * 1024 * 1024);
    writer
        .write_all(&vec![b'x'; 1024 * 1024 + 1])
        .await
        .unwrap();
    let error = tokio::time::timeout(http::TEST_TIMEOUT, http::read(&mut reader))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "fixture request exceeded capture bound");
}
