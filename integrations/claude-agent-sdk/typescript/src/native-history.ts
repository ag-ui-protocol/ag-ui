import { readFile, readdir, rename, writeFile, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface NativeCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface NativeResult {
  content: string;
  is_error?: boolean;
}
type Block = {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
};
type Row = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  agentId?: string;
  version?: string;
  message?: { role: string; content: string | Block[]; stop_reason?: string };
  [key: string]: unknown;
};
const blocks = (r: Row): Block[] =>
  Array.isArray(r.message?.content) ? r.message.content : [];
const interrupted = (b: Block) =>
  b.type === "tool_result" &&
  b.is_error === true &&
  typeof b.content === "string" &&
  b.content.startsWith("[Tool call interrupted:");
function calls(rows: Row[]): NativeCall[] {
  return rows.flatMap((r) =>
    blocks(r)
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        if (
          typeof b.id !== "string" ||
          typeof b.name !== "string" ||
          !b.input ||
          typeof b.input !== "object" ||
          Array.isArray(b.input)
        )
          throw new Error("Invalid native tool call");
        return { id: b.id, name: b.name, input: b.input };
      }),
  );
}
function pending(rows: Row[]) {
  const done = new Set(
    rows.flatMap((r) =>
      blocks(r)
        .filter((b) => b.type === "tool_result" && !interrupted(b))
        .map((b) => b.tool_use_id),
    ),
  );
  return calls(rows).filter((c) => !done.has(c.id));
}
async function read(path: string): Promise<Row[]> {
  if ((await lstat(path)).isSymbolicLink())
    throw new Error("Native transcripts must not be symlinks");
  const rows = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  if (rows.some((r) => r.version && r.version !== "2.1.306"))
    throw new Error(
      "Native child recovery requires verified CLI history version 2.1.306",
    );
  return rows;
}
async function replace(path: string, before: Row[], after: Row[]) {
  // Caller must hold exclusive ownership of the session. Detect external writers.
  const current = await read(path);
  if (JSON.stringify(current) !== JSON.stringify(before))
    throw new Error("Native history changed during recovery");
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, after.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, path);
}
export interface ChildCheckpoint {
  parentPath: string;
  childPath: string;
  childId: string;
  parent: NativeCall;
  pending: NativeCall[];
  calls: NativeCall[];
  final?: string;
}
export class NativeHistory {
  constructor(
    private directory: string,
    readonly sessionId: string,
    private tools: string[],
  ) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId))
      throw new Error("Invalid native session UUID");
  }
  async inspect(): Promise<ChildCheckpoint | undefined> {
    const matches: string[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true }))
      if (entry.isDirectory()) {
        const path = join(
          this.directory,
          entry.name,
          this.sessionId + ".jsonl",
        );
        try {
          await lstat(path);
          matches.push(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    if (matches.length !== 1)
      throw new Error("Expected one original native session");
    const parentPath = matches[0],
      root = await read(parentPath),
      unfinished = pending(root);
    const parents = unfinished.filter((c) => c.name === "Agent");
    if (!parents.length) return undefined;
    if (parents.length !== 1)
      throw new Error(
        "Native recovery currently requires one unresolved parent Agent call",
      );
    const folder = join(dirname(parentPath), this.sessionId, "subagents");
    const children = (await readdir(folder)).filter((n) =>
      /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(n),
    );
    if (children.length !== 1)
      throw new Error(
        "Native recovery requires exactly one child; ambiguous or nested recovery is unsupported",
      );
    const childPath = join(folder, children[0]),
      rows = await read(childPath),
      childId = children[0].slice(6, -6);
    if (
      unfinished.some(
        (c) =>
          c.id !== parents[0].id &&
          !(
            c.name === "SendMessage" &&
            c.input.to === childId &&
            c.input.message ===
              "Continue the original task using the recorded tool results. Do not repeat completed tools."
          ),
      )
    )
      throw new Error("Unresolved parent tools outside child recovery");
    if (rows.some((r) => r.agentId && r.agentId !== childId))
      throw new Error("Native child identity mismatch");
    const unresolved = pending(rows);
    if (unresolved.some((c) => !this.tools.includes(c.name)))
      throw new Error(
        "Unanswered child tool has no configured recovery executor",
      );
    const messages = rows.filter(
      (r) => r.type === "assistant" || r.type === "user",
    );
    const last = messages.at(-1);
    const final =
      last?.type === "assistant" && last.message?.stop_reason === "end_turn"
        ? blocks(last)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
        : undefined;
    return {
      parentPath,
      childPath,
      childId,
      parent: parents[0],
      pending: unresolved,
      calls: calls(rows),
      ...(final !== undefined ? { final } : {}),
    };
  }
  async answer(
    checkpoint: ChildCheckpoint,
    results: Record<string, NativeResult>,
  ) {
    const before = await read(checkpoint.childPath),
      rows = structuredClone(before),
      unresolved = pending(rows);
    if (Object.keys(results).some((id) => !unresolved.some((c) => c.id === id)))
      throw new Error("Answer does not match an unanswered native call");
    const last = rows.filter((r) => r.uuid).at(-1);
    const sources = rows.filter(
      (r) =>
        r.type === "assistant" &&
        blocks(r).some((b) => b.id && b.id in results),
    );
    if (!last?.uuid || !sources.length)
      throw new Error("Missing native call ancestry");
    // Replace interruption placeholders without changing their identity; append missing results as one batch.
    const remaining = new Map(Object.entries(results));
    for (const row of rows)
      for (const b of blocks(row))
        if (b.tool_use_id && remaining.has(b.tool_use_id) && interrupted(b)) {
          const result = remaining.get(b.tool_use_id)!;
          b.content = result.content;
          b.is_error = !!result.is_error;
          row.toolUseResult = result.content;
          delete row.toolDenialKind;
          remaining.delete(b.tool_use_id);
        }
    if (remaining.size) {
      const source = sources[0];
      rows.push({
        ...Object.fromEntries(
          [
            "sessionId",
            "agentId",
            "isSidechain",
            "cwd",
            "version",
            "userType",
            "entrypoint",
          ]
            .filter((k) => k in source)
            .map((k) => [k, source[k]]),
        ),
        type: "user",
        uuid: randomUUID(),
        parentUuid: last.uuid,
        sourceToolAssistantUUID: source.uuid,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [...remaining].map(([id, r]) => ({
            type: "tool_result",
            tool_use_id: id,
            content: r.content,
            is_error: !!r.is_error,
          })),
        },
      });
    }
    await replace(checkpoint.childPath, before, rows);
  }
  async settleBridge(
    checkpoint: ChildCheckpoint,
    results: Record<string, NativeResult>,
  ) {
    const unresolved = pending(await read(checkpoint.parentPath));
    const missing = Object.fromEntries(
      Object.entries(results).filter(([id]) =>
        unresolved.some((c) => c.id === id),
      ),
    );
    if (Object.keys(missing).length)
      await this.answer(
        { ...checkpoint, childPath: checkpoint.parentPath },
        missing,
      );
  }
  async completed(checkpoint: ChildCheckpoint): Promise<boolean> {
    const rows = await read(checkpoint.childPath),
      last = rows
        .filter((r) => r.type === "assistant" || r.type === "user")
        .at(-1);
    return (
      !pending(rows).length &&
      last?.type === "assistant" &&
      last.message?.stop_reason === "end_turn" &&
      !blocks(last).some((b) => b.type === "tool_use")
    );
  }
  async repair(checkpoint: ChildCheckpoint) {
    const fresh = await this.inspect();
    if (
      fresh?.final === undefined ||
      fresh.pending.length ||
      fresh.childId !== checkpoint.childId
    )
      throw new Error("Child has not completed recovery");
    const before = await read(fresh.parentPath),
      rows = structuredClone(before);
    // A crash may lose the in-memory SendMessage response even after the child
    // finishes. Never repair the Agent and resume with another unanswered call.
    if (pending(before).some((call) => call.id !== fresh.parent.id))
      throw new Error(
        "Unresolved recovery tool result; parent remains unresolved",
      );
    let changed = false;
    for (const r of rows)
      for (const b of blocks(r))
        if (b.tool_use_id === fresh.parent.id) {
          if (!interrupted(b))
            throw new Error("Parent result was already resolved");
          b.content = fresh.final;
          b.is_error = false;
          r.toolUseResult = fresh.final;
          delete r.toolDenialKind;
          changed = true;
        }
    if (!changed) {
      const source = rows.find((r) =>
          blocks(r).some((b) => b.id === fresh.parent.id),
        ),
        last = rows.filter((r) => r.uuid).at(-1);
      if (!source || !last) throw new Error("Parent call ancestry is missing");
      rows.push({
        type: "user",
        uuid: randomUUID(),
        parentUuid: last.uuid,
        sessionId: this.sessionId,
        version: source.version,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: fresh.parent.id,
              content: fresh.final,
              is_error: false,
            },
          ],
        },
        toolUseResult: fresh.final,
      });
    }
    await replace(fresh.parentPath, before, rows);
  }
}
