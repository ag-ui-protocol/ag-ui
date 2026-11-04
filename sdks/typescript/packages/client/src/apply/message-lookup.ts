import type { Message } from "@ag-ui/core";

// Marks an index whose message is not the first with its id.
const NO_KEY = Symbol("no key");

// Whether `message` carries a tool call with `toolCallId`, read the way the
// reducer's scans read it: any role, `toolCalls` as an array.
function hasToolCall(message: Message | undefined, toolCallId: string): boolean {
  const toolCalls = (message as { toolCalls?: unknown } | undefined)?.toolCalls;
  if (!Array.isArray(toolCalls)) return false;
  for (const toolCall of toolCalls) {
    if ((toolCall as { id?: unknown } | null)?.id === toolCallId) return true;
  }
  return false;
}

/**
 * Finds messages in the reducer's working list by id, and the message that
 * holds a tool call, without scanning the list on every event. In a long thread
 * those scans made each streamed event cost time proportional to the whole
 * history.
 *
 * Every answer is the one a front-to-back scan gives: `indexOf` is
 * `messages.findIndex((m) => m.id === id)`, and `toolCallOwner` is
 * `messages.find((m) => m.toolCalls?.some((tc) => tc.id === toolCallId))`.
 *
 * The tables describe one array, up to a length. They are rebuilt when the
 * reducer works on a different array (a snapshot, a subscriber's replacement)
 * or a shorter one, and extended when messages were appended. Any other
 * in-place change must be reported: `insertedBefore` for a message inserted
 * before the end, which re-indexes only the messages from that point on, and
 * `addedToolCall` for a tool call pushed onto a message's `toolCalls`.
 * Replacing a list entry with a message of the same id needs no report. A hit
 * is checked before it is returned, and a failed check rebuilds the tables, so
 * a stale hit costs a rebuild rather than a wrong answer.
 */
export class MessageLookup {
  private list: Message[] | undefined;
  private covered = 0;
  // Keyed by whatever the id is, like the `===` scans: unverified input can
  // carry a missing or non-string id.
  private readonly firstById = new Map<unknown, number>();
  private readonly firstByToolCallId = new Map<unknown, number>();
  // Per index, the keys whose first occurrence is there, so that forgetting
  // everything from an index on touches only the entries behind it.
  private idAt: unknown[] = [];
  private toolCallIdsAt: (unknown[] | undefined)[] = [];

  /** Index of the first message with `id`, or -1. */
  indexOf(messages: Message[], id: string): number {
    this.sync(messages);
    let index = this.firstById.get(id);
    if (index !== undefined && messages[index]?.id !== id) {
      this.rebuild(messages);
      index = this.firstById.get(id);
    }
    return index ?? -1;
  }

  /** The first message with `id`. */
  find(messages: Message[], id: string): Message | undefined {
    const index = this.indexOf(messages, id);
    return index === -1 ? undefined : messages[index];
  }

  /** The first message whose `toolCalls` includes `toolCallId`. */
  toolCallOwner(messages: Message[], toolCallId: string): Message | undefined {
    this.sync(messages);
    let index = this.firstByToolCallId.get(toolCallId);
    if (index !== undefined && !hasToolCall(messages[index], toolCallId)) {
      this.rebuild(messages);
      index = this.firstByToolCallId.get(toolCallId);
    }
    return index === undefined ? undefined : messages[index];
  }

  /** Reports a tool call with `toolCallId` just pushed onto `owner.toolCalls`. */
  addedToolCall(messages: Message[], owner: Message, toolCallId: string): void {
    if (messages !== this.list) return; // The next lookup rebuilds anyway.
    // Index anything appended since the last lookup first; that already
    // covers `owner` if it was just appended.
    this.sync(messages);
    const known = this.firstByToolCallId.get(toolCallId);
    if (known !== undefined && messages[known] === owner) return;
    if (known === undefined) {
      const ownerIndex = this.firstById.get(owner.id);
      if (ownerIndex !== undefined && messages[ownerIndex] === owner) {
        this.firstByToolCallId.set(toolCallId, ownerIndex);
        (this.toolCallIdsAt[ownerIndex] ??= []).push(toolCallId);
        return;
      }
    }
    // Another message already holds the id, or `owner` is not the first
    // message with its own id: rare enough to settle with a rebuild.
    this.invalidate();
  }

  /** Reports a message inserted into `messages` at `index`, before the end. */
  insertedBefore(messages: Message[], index: number): void {
    if (messages !== this.list || index >= this.covered) return;
    // Entries before `index` keep their positions and stay first; everything
    // from `index` on is indexed again on the next lookup.
    for (let at = this.covered - 1; at >= index; at--) {
      if (this.idAt[at] !== NO_KEY) this.firstById.delete(this.idAt[at]);
      for (const toolCallId of this.toolCallIdsAt[at] ?? []) {
        this.firstByToolCallId.delete(toolCallId);
      }
    }
    this.idAt.length = index;
    this.toolCallIdsAt.length = index;
    this.covered = index;
  }

  private invalidate(): void {
    this.list = undefined;
  }

  private sync(messages: Message[]): void {
    if (messages !== this.list || messages.length < this.covered) {
      this.rebuild(messages);
      return;
    }
    for (let index = this.covered; index < messages.length; index++) {
      this.add(messages[index], index);
    }
    this.covered = messages.length;
  }

  private rebuild(messages: Message[]): void {
    this.list = messages;
    this.covered = 0;
    this.firstById.clear();
    this.firstByToolCallId.clear();
    this.idAt = [];
    this.toolCallIdsAt = [];
    this.sync(messages);
  }

  private add(message: Message | undefined, index: number): void {
    this.idAt[index] = NO_KEY;
    this.toolCallIdsAt[index] = undefined;
    if (typeof message !== "object" || message === null) return;
    const id = (message as { id?: unknown }).id;
    if (!this.firstById.has(id)) {
      this.firstById.set(id, index);
      this.idAt[index] = id;
    }
    const toolCalls = (message as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) return;
    for (const toolCall of toolCalls) {
      if (typeof toolCall !== "object" || toolCall === null) continue;
      const toolCallId = (toolCall as { id?: unknown }).id;
      if (!this.firstByToolCallId.has(toolCallId)) {
        this.firstByToolCallId.set(toolCallId, index);
        (this.toolCallIdsAt[index] ??= []).push(toolCallId);
      }
    }
  }
}
