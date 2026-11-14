## The HTTP agent against a local server: it POSTs the run input as JSON,
## asks for an event stream, and hands every decoded event to the caller.

import std/[asyncdispatch, asynchttpserver, httpclient, json, options,
            strutils, unittest]
import ag_ui_nim/[core, encoder, client]

const sseHeaders = [("Content-Type", "text/event-stream")]

var lastRequestBody: JsonNode
var lastAccept: string

proc handle(req: Request) {.async, gcsafe.} =
  {.cast(gcsafe).}:
    lastRequestBody = parseJson(req.body)
    lastAccept = $req.headers.getOrDefault("Accept")
  case req.url.path
  of "/run":
    let body =
      ": keep-alive\n\n" &
      encodeSse(RunStartedEvent(threadId: "t1", runId: "r1").toEvent) &
      "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"m1\",\"later\":1}\n\n" &
      encodeSse(TextMessageContentEvent(messageId: "m1", delta: "hi").toEvent) &
      encodeSse(RunFinishedEvent(threadId: "t1", runId: "r1").toEvent)
    await req.respond(Http200, body, newHttpHeaders(sseHeaders))
  of "/truncated":
    await req.respond(Http200,
      encodeSse(RunStartedEvent(threadId: "t1", runId: "r1").toEvent) &
      "data: {\"type\":", newHttpHeaders(sseHeaders))
  of "/invalid":
    await req.respond(Http200, "data: {\"type\":\"TEXT_MESSAGE_CONTENT\"}\n\n",
      newHttpHeaders(sseHeaders))
  of "/json":
    await req.respond(Http200, "{}",
      newHttpHeaders([("Content-Type", "application/json")]))
  else:
    await req.respond(Http500, "boom")

proc startServer(): Port =
  let server = newAsyncHttpServer()
  server.listen(Port(0), "127.0.0.1")
  result = server.getPort
  proc loop() {.async.} =
    while true:
      if server.shouldAcceptRequest():
        await server.acceptRequest(handle)
      else:
        await sleepAsync(5)
  asyncCheck loop()

let port = startServer()

proc url(path: string): string =
  "http://127.0.0.1:" & $port.int & path

let input = RunAgentInput(threadId: "t1", runId: "r1", messages: @[
  UserMessage(id: "u1", content: textContent("hello")).toMessage])

suite "HttpAgent":
  test "the request body is the run input and the agent asks for SSE":
    var events: seq[Event]
    waitFor newHttpAgent(url("/run")).runAgent(input,
      proc (e: Event) = events.add(e),
      proc (w: string) = discard(w))
    check lastRequestBody == input.toJson
    check lastAccept == "text/event-stream"

  test "every event reaches the caller in order, unknown fields stripped with a warning":
    var kinds: seq[EventType]
    var warnings: seq[string]
    waitFor newHttpAgent(url("/run")).runAgent(input,
      proc (e: Event) = kinds.add(e.kind),
      proc (w: string) = warnings.add(w))
    check kinds == @[etRunStarted, etTextMessageStart, etTextMessageContent,
                     etRunFinished]
    check warnings == @["/later: unknown property stripped"]

  test "the events fold into the conversation":
    var s = AgentState(messages: input.messages)
    waitFor newHttpAgent(url("/run")).runAgent(input,
      proc (e: Event) = s.applyEvent(e),
      proc (w: string) = discard(w))
    check s.messages.len == 2
    check s.messages[1].assistant.content == some("hi")

  test "a stream that ends inside a message is reported":
    var warnings: seq[string]
    var count = 0
    waitFor newHttpAgent(url("/truncated")).runAgent(input,
      proc (e: Event) = inc(count),
      proc (w: string) = warnings.add(w))
    check count == 1
    check warnings.len == 1
    check "incomplete" in warnings[0]

  test "an event the schema rejects fails the run":
    expect ValidationError:
      waitFor newHttpAgent(url("/invalid")).runAgent(input,
        proc (e: Event) = discard e, proc (w: string) = discard(w))

  test "an HTTP error status fails the run with the status and body":
    try:
      waitFor newHttpAgent(url("/fail")).runAgent(input,
        proc (e: Event) = discard e, proc (w: string) = discard(w))
      fail()
    except AgentTransportError as e:
      check e.status == 500
      check "boom" in e.msg

  test "a response that is not an event stream fails the run":
    try:
      waitFor newHttpAgent(url("/json")).runAgent(input,
        proc (e: Event) = discard e, proc (w: string) = discard(w))
      fail()
    except AgentTransportError as e:
      check e.status == 200
      check "application/json" in e.msg
