## An agent reached over HTTP: the run input is POSTed as JSON and the
## response is an SSE stream of events, decoded with the receiver policy
## (unknown fields stripped, deprecated nulls read as absent, both reported
## through the warning callback).

import std/[asyncdispatch, asyncstreams, httpclient, json, strutils]
import ../core/[events, types]
import ../encoder/encoder
import ./sse

type
  HttpAgent* = ref object
    url*: string
    headers*: HttpHeaders ## sent with every run, e.g. authorization

  AgentTransportError* = object of CatchableError
    ## The server did not answer with an event stream.
    status*: int ## the HTTP status code of the response

  EventCallback* = proc (event: Event) {.closure.}
  WarningCallback* = proc (message: string) {.closure.}

proc newHttpAgent*(url: string, headers = newHttpHeaders()): HttpAgent {.
    raises: [].} =
  HttpAgent(url: url, headers: headers)

proc transportError(status: int, message: string): ref AgentTransportError {.
    raises: [].} =
  result = newException(AgentTransportError, message)
  result.status = status

proc runAgent*(agent: HttpAgent, input: RunAgentInput, onEvent: EventCallback,
               onWarning: WarningCallback): Future[void] {.async.} =
  ## Runs the agent once, calling `onEvent` for each event as it arrives.
  ## Fails with `AgentTransportError` when the response is not a 2xx event
  ## stream, and with `ValidationError` or `JsonParsingError` when an event
  ## cannot be decoded.
  let client = newAsyncHttpClient()
  try:
    let headers = newHttpHeaders()
    for key, value in agent.headers.pairs:
      headers.add(key, value)
    headers["Content-Type"] = "application/json"
    headers["Accept"] = SseContentType
    let response = await client.request(agent.url, HttpPost, $input.toJson,
                                        headers)
    let status = response.code.int
    if not response.code.is2xx:
      let body = await response.body
      raise transportError(status, "HTTP " & $status & " from " & agent.url &
        ": " & body)
    let contentType = $response.headers.getOrDefault("Content-Type")
    if not contentType.toLowerAscii.startsWith(SseContentType):
      raise transportError(status, "expected " & SseContentType &
        " from " & agent.url & ", got '" & contentType & "'")
    var parser = initSseParser()
    while true:
      let (hasChunk, chunk) = await response.bodyStream.read()
      if not hasChunk:
        break
      for message in parser.feed(chunk):
        var ctx = receiverContext()
        let event = fromJson(parseJson(message.data), Event, ctx)
        for warning in ctx.warnings:
          onWarning(warning)
        onEvent(event)
    if parser.finish():
      onWarning("the stream ended inside an incomplete SSE message, " &
        "which was discarded")
  finally:
    client.close()
