type StreamResponseChunk = any;
type SubgraphStreamEvent = any;

export function isSubgraphStreamEvent(
  event: StreamResponseChunk,
): event is StreamResponseChunk & { method: "lifecycle"; params: { data: SubgraphStreamEvent } } {
    // OLD:
    // (streamResponseChunk.event.startsWith("events") ||
    //             streamResponseChunk.event.startsWith("values"))

  return event?.method === "lifecycle" && event?.params?.data?.type === "subgraph";
}

// "messages-tuple" stream mode produces SSE events with type "messages",
// so we need to check for that mapping in addition to the direct mode name.
export function isMessageTupleEvent(event: StreamResponseChunk): event is StreamResponseChunk & { method: "lifecycle"; params: { data: { type: "message_tuple"; message: any } } } {
    // OLD:
    // streamResponseChunk.event === "messages" &&
    //           (Array.isArray(streamModes) ? streamModes : [streamModes]).includes(
    //             "messages-tuple" as StreamMode,
    //           )

    return event?.method === "lifecycle" && event?.params?.data?.type === "message_tuple";
}