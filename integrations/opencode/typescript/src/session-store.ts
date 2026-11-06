import { BridgeError } from "./errors";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MapperState } from "./event-mapper";
import type { PendingInterrupt } from "./permissions";

export interface SessionRecord {
  sessionID: string;
  consumed: string[];
  active?: { messageID: string; userID: string };
  pending?: PendingInterrupt;
  mapper?: MapperState;
}
export interface SessionStore {
  /** Must exclude other processes as well as concurrent requests. */
  acquire(key: string): Promise<() => Promise<void>>;
  read(key: string): Promise<SessionRecord | undefined>;
  write(key: string, value: SessionRecord): Promise<void>;
}
export function sessionKey(
  owner: string,
  threadId: string,
  directory: string,
): string {
  if (!owner || !threadId)
    throw new BridgeError("An authenticated owner and thread ID are required");
  return createHash("sha256")
    .update(JSON.stringify([owner, threadId, resolve(directory)]))
    .digest("hex");
}
/** Atomic local-disk persistence. Use one host, or provide a transactional distributed store. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new BridgeError("Invalid session key");
    return join(this.directory, key);
  }
  async acquire(key: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = `${this.path(key)}.lock`;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw new BridgeError(
        "Thread is busy (or has an unrecovered process lock)",
      );
    }
    return async () => {
      await rm(path, { recursive: true, force: true });
    };
  }
  async read(key: string): Promise<SessionRecord | undefined> {
    try {
      return JSON.parse(await readFile(`${this.path(key)}.json`, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(key: string, value: SessionRecord) {
    const path = `${this.path(key)}.json`;
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  }
}
