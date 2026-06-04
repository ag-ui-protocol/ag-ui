type StreamResponseChunk = any;
type SubgraphStreamEvent = any;

export function isSubgraphStreamEvent(
  chunkData: StreamResponseChunk,
): chunkData is StreamResponseChunk & { method: "lifecycle"; params: { data: SubgraphStreamEvent } } {
    // OLD:
    // (streamResponseChunk.event.startsWith("events") ||
    //             streamResponseChunk.event.startsWith("values"))

  return chunkData.method === "lifecycle" && chunkData.params.data.type === "subgraph";
}

// TODO: is it needed?
// "messages-tuple" stream mode produces SSE events with type "messages",
// so we need to check for that mapping in addition to the direct mode name.
export function isMessageTupleEvent(chunkData: StreamResponseChunk): chunkData is StreamResponseChunk & { method: "lifecycle"; params: { data: { type: "message_tuple"; message: any } } } {
    // OLD:
    // streamResponseChunk.event === "messages" &&
    //           (Array.isArray(streamModes) ? streamModes : [streamModes]).includes(
    //             "messages-tuple" as StreamMode,
    //           )

    return chunkData.method === "lifecycle" && chunkData.params.data.type === "message_tuple";
}