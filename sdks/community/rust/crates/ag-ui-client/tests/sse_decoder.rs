use ag_ui_client::error::AgUiClientError;
use ag_ui_client::sse::{SseDecoder, SseEvent, SseLimits};
use bytes::Bytes;
use futures::{StreamExt, stream};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn decode(chunks: Vec<Bytes>, limits: SseLimits) -> Vec<Result<SseEvent, AgUiClientError>> {
    SseDecoder::new(stream::iter(chunks.into_iter().map(Ok)), limits)
        .collect()
        .await
}

fn data(results: Vec<Result<SseEvent, AgUiClientError>>) -> Vec<String> {
    results
        .into_iter()
        .map(|event| event.unwrap().data)
        .collect()
}

#[tokio::test]
async fn every_byte_split_is_invariant_for_unicode_bom_and_all_line_endings() {
    for newline in ["\n", "\r\n", "\r"] {
        let text = format!(
            "\u{feff}: heartbeat{newline}{newline}event: update{newline}id: 7{newline}data: {{\"text\":\"h😺éllo\\n世界\"}}{newline}{newline}data: first{newline}data: second{newline}{newline}"
        );
        let expected = decode(
            vec![Bytes::copy_from_slice(text.as_bytes())],
            SseLimits::default(),
        )
        .await;
        assert_eq!(expected.len(), 2);
        let expected: Vec<_> = expected.into_iter().map(Result::unwrap).collect();
        assert_eq!(expected[0].id.as_deref(), Some("7"));
        assert_eq!(expected[0].event.as_deref(), Some("update"));
        assert_eq!(expected[1].data, "first\nsecond");
        for split in 0..=text.len() {
            let actual = decode(
                vec![
                    Bytes::copy_from_slice(&text.as_bytes()[..split]),
                    Bytes::copy_from_slice(&text.as_bytes()[split..]),
                ],
                SseLimits::default(),
            )
            .await;
            let actual: Vec<_> = actual.into_iter().map(Result::unwrap).collect();
            assert_eq!(actual, expected, "split {split}, newline {newline:?}");
        }
        let actual = decode(
            text.bytes().map(|b| Bytes::from(vec![b])).collect(),
            SseLimits::default(),
        )
        .await;
        assert_eq!(
            actual.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            expected
        );
    }
}

#[tokio::test]
async fn comments_and_no_data_frames_are_skipped_but_empty_data_dispatches() {
    let input = b": keepalive\n\nevent: ignored\nid: ignored\nretry: 1000\n\ndata\n\ndata: \n\ndata:  whitespace \n\nid: bad\0id\ndata: last\n\n";
    let events = decode(vec![Bytes::from_static(input)], SseLimits::default()).await;
    assert_eq!(events.len(), 4);
    assert!(events.last().unwrap().as_ref().unwrap().id.is_none());
    assert_eq!(data(events), ["", "", " whitespace ", "last"]);
    assert!(
        decode(
            vec![Bytes::from_static(b": comment without final newline")],
            SseLimits::default()
        )
        .await
        .is_empty()
    );
    assert!(
        decode(
            vec![Bytes::from_static(b": a\r: b\n\n")],
            SseLimits::default()
        )
        .await
        .is_empty()
    );
}

#[tokio::test]
async fn incomplete_frames_and_utf8_are_distinct_from_clean_eof() {
    for bytes in [b"data: x".as_slice(), b"data: x\n", b"data:\n", b"junk"] {
        let events = decode(vec![Bytes::copy_from_slice(bytes)], SseLimits::default()).await;
        assert!(matches!(
            events.as_slice(),
            [Err(AgUiClientError::SseTruncated)]
        ));
    }
    for bytes in [b"data: \xf0\x9f".as_slice(), b": \xf0\x9f"] {
        let events = decode(
            bytes.iter().map(|b| Bytes::from(vec![*b])).collect(),
            SseLimits::default(),
        )
        .await;
        assert!(matches!(
            events.as_slice(),
            [Err(AgUiClientError::SseInvalidUtf8 { incomplete: true })]
        ));
    }
    let events = decode(
        vec![Bytes::from_static(b"data: \xff\n\n")],
        SseLimits::default(),
    )
    .await;
    assert!(matches!(
        events.as_slice(),
        [Err(AgUiClientError::SseInvalidUtf8 { incomplete: false })]
    ));
    let events = decode(
        vec![Bytes::from_static(b"data: valid\n\ndata: truncated")],
        SseLimits::default(),
    )
    .await;
    assert_eq!(events[0].as_ref().unwrap().data, "valid");
    assert!(matches!(events[1], Err(AgUiClientError::SseTruncated)));
}

#[tokio::test]
async fn only_stream_initial_bom_is_removed() {
    assert_eq!(
        data(
            decode(
                vec![Bytes::from_static(b"\xef\xbb\xbfdata: first\n\n")],
                SseLimits::default()
            )
            .await
        ),
        ["first"]
    );

    let events = decode(
        vec![Bytes::from_static(
            b"data: first\n\n\xef\xbb\xbfdata: second\n\n",
        )],
        SseLimits::default(),
    )
    .await;
    assert_eq!(data(events), ["first"]);
    assert!(
        decode(
            vec![Bytes::from_static(b"\xef\xbb\xbf")],
            SseLimits::default()
        )
        .await
        .is_empty()
    );
}

#[tokio::test]
async fn exact_limits_and_comment_growth_are_bounded_without_changing_delivery() {
    let limits = SseLimits {
        max_line_bytes: 7,
        max_frame_bytes: 8,
    };
    assert_eq!(
        data(decode(vec![Bytes::from_static(b"data: x\n\n")], limits).await),
        ["x"]
    );
    let over_line = decode(vec![Bytes::from_static(b"data: xx\n\n")], limits).await;
    assert!(matches!(
        over_line.as_slice(),
        [Err(AgUiClientError::SseLimitExceeded { kind: "line", .. })]
    ));
    let over_frame = decode(vec![Bytes::from_static(b"data: x\ndata: y\n\n")], limits).await;
    assert!(matches!(
        over_frame.as_slice(),
        [Err(AgUiClientError::SseLimitExceeded { kind: "frame", .. })]
    ));
    let comments = format!("{}data: x\n\n", ": ping\n".repeat(10000));
    assert_eq!(
        data(decode(vec![Bytes::from(comments)], limits).await),
        ["x"]
    );
}

#[tokio::test]
async fn many_coalesced_frames_are_partition_invariant_and_source_is_backpressured() {
    let frame = b"data: ok\n\n";
    let all = frame.repeat(10000);
    let limits = SseLimits {
        max_line_bytes: 8,
        max_frame_bytes: 9,
    };
    let coalesced = data(decode(vec![Bytes::from(all.clone())], limits).await);
    let framed = data(
        decode(
            (0..10000).map(|_| Bytes::from_static(frame)).collect(),
            limits,
        )
        .await,
    );
    let bytes = data(
        decode(
            all.into_iter().map(|b| Bytes::from(vec![b])).collect(),
            limits,
        )
        .await,
    );
    assert_eq!(coalesced.len(), 10000);
    assert_eq!(coalesced, framed);
    assert_eq!(coalesced, bytes);

    let polls = Arc::new(AtomicUsize::new(0));
    let captured = polls.clone();
    let source = stream::iter([
        Ok(Bytes::from(frame.repeat(100))),
        Ok(Bytes::from_static(frame)),
    ])
    .inspect(move |_| {
        captured.fetch_add(1, Ordering::SeqCst);
    });
    let mut decoder = SseDecoder::new(source, limits);
    for _ in 0..100 {
        assert_eq!(decoder.next().await.unwrap().unwrap().data, "ok");
    }
    assert_eq!(
        polls.load(Ordering::SeqCst),
        1,
        "do not poll ahead of queued current chunk"
    );
    assert_eq!(decoder.next().await.unwrap().unwrap().data, "ok");
    assert_eq!(polls.load(Ordering::SeqCst), 2);
}
