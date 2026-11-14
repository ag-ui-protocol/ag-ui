## Consumer side of the HTTP transport: an incremental Server-Sent Events
## parser following WHATWG HTML, "Parsing an event stream". It only splits
## the stream into messages; decoding their data is the caller's job.

import std/strutils

type
  SseMessage* = object
    data*: string  ## the data lines, joined with LF
    event*: string ## the `event` field, empty when the message had none
    id*: string    ## the last `id` seen on the stream

  SseParser* = object
    line: string
    afterCR: bool        ## the previous character ended a line with CR
    bomChecked: bool
    pendingStart: string ## the first bytes, until the BOM check can decide
    data: string
    hasData: bool
    event: string
    lastId: string

const bom = "\xEF\xBB\xBF"

proc initSseParser*(): SseParser {.raises: [].} =
  SseParser()

proc processLine(p: var SseParser, messages: var seq[SseMessage]) {.raises: [].} =
  let line = move(p.line)
  p.line = ""
  if line.len == 0:
    if p.hasData:
      var data = move(p.data)
      if data.len > 0 and data[^1] == '\n':
        data.setLen(data.len - 1)
      messages.add SseMessage(data: data, event: p.event, id: p.lastId)
    p.data = ""
    p.hasData = false
    p.event = ""
    return
  if line[0] == ':':
    return # a comment
  var field = line
  var value = ""
  let colon = line.find(':')
  if colon >= 0:
    field = line[0 ..< colon]
    value = line[colon + 1 .. ^1]
    if value.len > 0 and value[0] == ' ':
      value = value[1 .. ^1]
  case field
  of "data":
    p.data.add value
    p.data.add '\n'
    p.hasData = true
  of "event":
    p.event = value
  of "id":
    if '\0' notin value:
      p.lastId = value
  else:
    discard # `retry` and unknown fields do not concern a one-shot run

proc feed*(p: var SseParser, chunk: string): seq[SseMessage] {.raises: [].} =
  ## Consumes the next chunk of the stream and returns the messages it
  ## completed.
  var text = chunk
  if not p.bomChecked:
    p.pendingStart.add text
    if p.pendingStart.len < bom.len and bom[0 ..< p.pendingStart.len] == p.pendingStart:
      return
    p.bomChecked = true
    text = move(p.pendingStart)
    if text.len >= bom.len and text[0 ..< bom.len] == bom:
      text = text[bom.len .. ^1]
  for c in text:
    case c
    of '\n':
      if p.afterCR:
        p.afterCR = false
      else:
        p.processLine(result)
    of '\r':
      p.afterCR = true
      p.processLine(result)
    else:
      p.afterCR = false
      p.line.add c

proc finish*(p: var SseParser): bool {.raises: [].} =
  ## Ends the stream. Returns true when it ended inside a message, which the
  ## specification discards.
  result = p.line.len > 0 or p.hasData or p.pendingStart.len > 0
  p = initSseParser()
