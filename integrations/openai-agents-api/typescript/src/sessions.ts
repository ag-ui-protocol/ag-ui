import type { SessionRecord, SessionStore } from "./types";

export const IN_MEMORY_SESSION_STORE_MAX_ENTRIES = 10_000;

/**
 * The default store. Bounded because thread ids are client-supplied: past the
 * cap the least recently used mapping is evicted and that thread starts a new
 * session on its next run.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  constructor(
    private readonly maxEntries = IN_MEMORY_SESSION_STORE_MAX_ENTRIES,
  ) {}

  get(key: string): SessionRecord | undefined {
    const record = this.records.get(key);
    if (record) {
      // Refresh recency.
      this.records.delete(key);
      this.records.set(key, record);
    }
    return record ? structuredClone(record) : undefined;
  }

  set(key: string, record: SessionRecord): void {
    this.records.delete(key);
    this.records.set(key, structuredClone(record));
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  delete(key: string): void {
    this.records.delete(key);
  }
}

export const newSessionRecord = (sessionId: string): SessionRecord => ({
  sessionId,
  toolsFingerprint: "",
  deliveredMessageIds: [],
  surfacedItemIds: [],
  clientToolCallIds: [],
  answeredCallIds: [],
  openInterrupts: {},
});

/** Keep id lists from growing without bound over a long thread. */
export const MAX_REMEMBERED_IDS = 2_000;

export const remember = (list: string[], id: string): void => {
  if (list.includes(id)) return;
  list.push(id);
  if (list.length > MAX_REMEMBERED_IDS)
    list.splice(0, list.length - MAX_REMEMBERED_IDS);
};

export const forget = (list: string[], id: string): void => {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
};
