/**
 * State helpers + RunState persistence for the OpenAI Agents JS adapter.
 *
 * Phase 3 added the `hasState` predicate (decides whether to inject the
 * `ag_ui_update_state` tool). Phase 4 added state interception / snapshot
 * merging. Phase 5 adds the `RunState` pause/resume store: a pluggable
 * persistence interface (default in-memory impl) that stashes the shared
 * `currentState` per `threadId` so a resumed run hydrates state even when the
 * frontend doesn't resend it.
 */

/** Default max idle RunState entries kept for pause/resume. */
export const DEFAULT_MAX_STATES = 1000;

/** Default TTL (ms) for idle RunState entries. */
export const DEFAULT_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * Whether a state value is meaningful (non-null, non-undefined).
 *
 * The CopilotKit runtime sends `state: {}` even for agents that don't use a
 * shared state. We treat any object (including `{}`) as "has state" so the
 * state tool is injected and the model can populate it; `null`/`undefined`
 * mean no state is in play.
 *
 * (Mirrors the claude-agent-sdk `hasState` predicate so both integrations
 * agree on when state is active.)
 */
export function hasState(state: unknown): boolean {
  return state != null;
}

/**
 * Persistence seam for the shared `currentState` across a HITL pause/resume.
 *
 * The adapter depends on this *interface*, not any implementation, so SDK
 * users can plug in a DynamoDB / S3 / Redis-backed store (or any durable
 * backend) without touching the adapter. We ship an `InMemoryRunStateStore`
 * as the default; inject a custom one via `OpenAIAgentsAdapterConfig.runStateStore`.
 *
 * Methods are async so a remote backend can fulfil them over the network.
 */
export interface RunStateStore {
  /** Return the stashed state for `threadId`, or `undefined` if none/expired. */
  get(threadId: string): Promise<unknown | undefined>;
  /** Stash (or replace) the state for `threadId`. */
  set(threadId: string, state: unknown): Promise<void>;
  /** Remove the stashed state for `threadId` (if any). */
  delete(threadId: string): Promise<void>;
}

/** A single in-memory RunState entry. */
interface InMemoryEntry {
  state: unknown;
  /** Epoch ms of the last `set`/`get` — used for both TTL expiry and LRU. */
  lastUsed: number;
}

/**
 * Default `RunStateStore`: an in-memory `Map<threadId, { state, lastUsed }>`
 * with TTL expiry and LRU cap. Pure and unit-testable; no external deps.
 *
 * Eviction is lazy (runs on `set`): idle entries older than `ttlMs` are
 * dropped, and if the store is still over `maxStates`, the oldest idle
 * entries are evicted until under the cap.
 */
export class InMemoryRunStateStore implements RunStateStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly ttlMs: number;
  private readonly maxStates: number;

  constructor(opts?: { maxStates?: number; ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_STATE_TTL_MS;
    this.maxStates = opts?.maxStates ?? DEFAULT_MAX_STATES;
  }

  async get(threadId: string): Promise<unknown | undefined> {
    const entry = this.entries.get(threadId);
    if (!entry) return undefined;
    // Lazy TTL: treat as missing if expired.
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.entries.delete(threadId);
      return undefined;
    }
    entry.lastUsed = Date.now();
    return entry.state;
  }

  async set(threadId: string, state: unknown): Promise<void> {
    this.entries.set(threadId, { state, lastUsed: Date.now() });
    this.evict();
  }

  async delete(threadId: string): Promise<void> {
    this.entries.delete(threadId);
  }

  /** Current entry count (exposed for tests / diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop idle entries older than the TTL, then if still over `maxStates`,
   * evict the oldest idle entries until under the cap. An entry is "idle"
   * once it's older than the TTL; we never evict fresh-in-use entries except
   * by LRU when the hard cap is exceeded.
   */
  private evict(): void {
    const now = Date.now();
    // TTL sweep.
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    // LRU cap: remove oldest until under the limit.
    if (this.entries.size <= this.maxStates) return;
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );
    for (const [key] of sorted) {
      if (this.entries.size <= this.maxStates) break;
      this.entries.delete(key);
    }
  }
}
