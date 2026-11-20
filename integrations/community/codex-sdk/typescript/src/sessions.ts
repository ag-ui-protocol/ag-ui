import { CodexAdapterError } from "./errors";

export type CodexSessionRecord =
  | { status: "reserved"; nativeId?: string; fingerprints: string[] }
  | { status: "ready"; nativeId: string; fingerprints: string[] }
  | { status: "failed"; nativeId?: string; fingerprints: string[] };

export interface CodexSessionStore {
  acquire(threadId: string): void;
  get(threadId: string): CodexSessionRecord | undefined;
  set(threadId: string, record: CodexSessionRecord): void;
  delete(threadId: string): void;
  release(threadId: string): void;
}

export interface MemoryCodexSessionStoreOptions {
  maxEntries?: number;
  idleTtlMs?: number;
}

type Entry = { record?: CodexSessionRecord; active: boolean; touched: number };

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export class MemoryCodexSessionStore implements CodexSessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;

  constructor(options: MemoryCodexSessionStoreOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 1000, "maxEntries");
    this.idleTtlMs = positiveInteger(
      options.idleTtlMs ?? 30 * 60 * 1000,
      "idleTtlMs",
    );
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (!entry.active && now - entry.touched >= this.idleTtlMs)
        this.entries.delete(id);
    }
  }

  acquire(threadId: string): void {
    this.prune();
    const entry = this.entries.get(threadId);
    if (entry?.active) {
      throw new CodexAdapterError(
        "THREAD_BUSY",
        "A run is already active on this thread.",
      );
    }
    if (entry) {
      entry.active = true;
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      let oldest: [string, Entry] | undefined;
      for (const candidate of this.entries) {
        if (
          !candidate[1].active &&
          (!oldest || candidate[1].touched < oldest[1].touched)
        ) {
          oldest = candidate;
        }
      }
      if (!oldest)
        throw new CodexAdapterError(
          "SESSION_CAPACITY",
          "All session slots are active. Retry after a run finishes.",
        );
      this.entries.delete(oldest[0]);
    }
    this.entries.set(threadId, { active: true, touched: Date.now() });
  }

  get(threadId: string): CodexSessionRecord | undefined {
    this.prune();
    const record = this.entries.get(threadId)?.record;
    return record ? structuredClone(record) : undefined;
  }

  set(threadId: string, record: CodexSessionRecord): void {
    const entry = this.entries.get(threadId);
    if (!entry?.active)
      throw new Error("Acquire the session before writing it.");
    entry.record = structuredClone(record);
  }

  delete(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (entry?.active) {
      entry.record = undefined;
    } else {
      this.entries.delete(threadId);
    }
  }

  release(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    if (!entry.record) {
      this.entries.delete(threadId);
      return;
    }
    entry.active = false;
    entry.touched = Date.now();
  }
}
