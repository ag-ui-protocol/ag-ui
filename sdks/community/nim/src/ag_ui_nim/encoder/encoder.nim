## Producer side of the HTTP transport: events framed as Server-Sent Events.
##
## Each event is one SSE message whose `data` field is the event's JSON.
## The JSON is compact, so it never spans more than one `data:` line.

import std/json
import ../core/events

const SseContentType* = "text/event-stream"
  ## The `Content-Type` of an AG-UI SSE response.

proc encodeSse*(event: Event): string {.raises: [].} =
  ## `data: <event JSON>` followed by the blank line that ends the message.
  "data: " & $event.toJson & "\n\n"
