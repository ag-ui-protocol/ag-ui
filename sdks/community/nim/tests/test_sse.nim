## Server-Sent Events: the producer's framing and the consumer's parser
## (WHATWG HTML, "Parsing an event stream").

import std/[json, strutils, unittest]
import ag_ui_nim/[core, encoder, client]

proc parseAll(chunks: varargs[string]): seq[SseMessage] =
  var p = initSseParser()
  for chunk in chunks:
    result.add p.feed(chunk)

suite "SSE encoder":
  test "an event is one data line followed by a blank line":
    let frame = encodeSse(TextMessageEndEvent(messageId: "m1").toEvent)
    check frame == "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"m1\"}\n\n"

  test "a newline inside a string stays escaped on the one data line":
    let frame = encodeSse(TextMessageContentEvent(messageId: "m",
      delta: "a\nb").toEvent)
    check frame.count('\n') == 2

  test "the encoder's output parses back to the same event":
    let event = CustomEvent(name: "n", value: %*{"x": [1, nil]}).toEvent
    let messages = parseAll(encodeSse(event))
    check messages.len == 1
    check fromJson(parseJson(messages[0].data), Event).toJson == event.toJson

suite "SSE parser":
  test "a message ends at a blank line and its data lines join with LF":
    let m = parseAll("data: a\ndata: b\n\n")
    check m.len == 1
    check m[0].data == "a\nb"

  test "a message split across chunks is reassembled":
    let m = parseAll("da", "ta: hel", "lo\n", "\n")
    check m.len == 1
    check m[0].data == "hello"

  test "CRLF, CR and LF all end a line, even when CRLF straddles two chunks":
    check parseAll("data: a\r\n\r\n")[0].data == "a"
    check parseAll("data: a\r\r")[0].data == "a"
    let m = parseAll("data: a\r", "\n\r", "\ndata: b\n\n")
    check m.len == 2
    check m[1].data == "b"

  test "comments are ignored and a message without data is not dispatched":
    let m = parseAll(": keep-alive\n\nevent: ping\n\ndata: x\n\n")
    check m.len == 1
    check m[0].data == "x"

  test "only one space after the colon is removed; a field without a colon has an empty value":
    let m = parseAll("data:  two\ndata\n\n")
    check m[0].data == " two\n"

  test "the event and id fields are reported":
    let m = parseAll("event: update\nid: 7\ndata: x\n\n")
    check m[0].event == "update"
    check m[0].id == "7"

  test "a leading byte order mark is skipped":
    check parseAll("\xEF\xBB", "\xBFdata: x\n\n")[0].data == "x"

  test "finishing inside an unterminated message reports that it was discarded":
    var p = initSseParser()
    check p.feed("data: partial").len == 0
    check p.finish()
    var q = initSseParser()
    discard q.feed("data: whole\n\n")
    check not q.finish()
