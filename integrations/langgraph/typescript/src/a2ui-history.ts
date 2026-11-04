import type { Message } from "@langchain/langgraph-sdk";

/**
 * Insert a supplied A2UI outcome next to its saved call. LangGraph's message
 * reducer only appends new IDs, so an outcome arriving after a persisted user
 * turn needs an atomic channel overwrite. Every saved message is retained.
 * This never invents results or completes an approval: the middleware/caller
 * must supply the actual outcome first.
 */
export function recoverA2UIHistory(
  saved: Message[],
  incoming: Message[],
  toolName = "render_a2ui",
): Message[] | undefined {
  const answered = new Set(
    saved.flatMap((message) =>
      message.type === "tool" ? [message.tool_call_id] : [],
    ),
  );
  const results = new Map(
    incoming.flatMap((message) =>
      message.type === "tool" && !answered.has(message.tool_call_id)
        ? [[message.tool_call_id, message] as const]
        : [],
    ),
  );
  const recovered = new Set<string>();
  const history: Message[] = [];
  for (let index = 0; index < saved.length; index++) {
    const message = saved[index];
    history.push(message);
    if (message.type !== "ai") continue;
    const insert = (message.tool_calls ?? []).flatMap((call) => {
      if (!call.id) return [];
      const result = results.get(call.id);
      if (call.name !== toolName || !result || recovered.has(call.id))
        return [];
      recovered.add(call.id);
      return [result];
    });
    // Keep existing parallel tool results in their original order, then add
    // the missing result before the next user/assistant message.
    while (insert.length && saved[index + 1]?.type === "tool")
      history.push(saved[++index]);
    history.push(...insert);
  }
  if (!recovered.size) return undefined;
  const ids = new Set(saved.map((message) => message.id));
  history.push(
    ...incoming.filter(
      (message) =>
        !ids.has(message.id) &&
        !(message.type === "tool" && recovered.has(message.tool_call_id)),
    ),
  );
  return history;
}

/** A saved outcome is authoritative even when an imported client assigns a new ID. */
export function preserveCompletedA2UIResults(
  saved: Message[],
  incoming: Message[],
  toolName = "render_a2ui",
): Message[] {
  const renderIds = new Set(
    saved.flatMap((message) =>
      message.type === "ai"
        ? (message.tool_calls ?? [])
            .filter((call) => call.name === toolName)
            .map((call) => call.id)
        : [],
    ),
  );
  const completed = new Set(
    saved.flatMap((message) =>
      message.type === "tool" && renderIds.has(message.tool_call_id)
        ? [message.tool_call_id]
        : [],
    ),
  );
  return incoming.filter(
    (message) =>
      message.type !== "tool" || !completed.has(message.tool_call_id),
  );
}
