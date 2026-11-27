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
  (r.type === "assistant" || r.type === "user") &&
  Array.isArray(r.message?.content)
    ? r.message.content
    : [];
const interrupted = (b: Block) =>
  b.type === "tool_result" &&
  b.is_error === true &&
  typeof b.content === "string" &&
  b.content.startsWith("[Tool call interrupted:");
function calls(rows: Row[]): NativeCall[] {
  return rows
    .filter((r) => r.type === "assistant")
    .flatMap((r) =>
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
    rows
      .filter((r) => r.type === "user")
      .flatMap((r) =>
        blocks(r)
          .filter((b) => b.type === "tool_result" && !interrupted(b))
          .map((b) => b.tool_use_id),
      ),
  );
  for (const id of supersededRecoveryBridges(rows)) done.add(id);
  return calls(rows).filter((c) => !done.has(c.id));
}
function supersededRecoveryBridges(rows: Row[]): string[] {
  // Preserve the original unknown result. Only the identical internal recovery
  // control can be superseded by a later actual successful delivery receipt.
  const message =
    "Continue the original task using the recorded tool results. Do not repeat completed tools.";
  const bridges: {
    id: string;
    target: string;
    unknown: boolean;
    delivered: boolean;
  }[] = [];
  let prompt: unknown;
  for (const row of rows) {
    if (row.type === "user") prompt = row.message?.content;
    if (row.type !== "assistant" || row.agentId) continue;
    for (const call of blocks(row)) {
      const args = call.input;
      if (
        call.name !== "SendMessage" ||
        !call.id ||
        typeof args?.to !== "string" ||
        args.message !== message ||
        prompt !==
          `Resume child ${args.to} with SendMessage, message exactly: ${message}`
      )
        continue;
      const results = rows
        .filter((r) => r.type === "user")
        .flatMap(blocks)
        .filter((b) => b.type === "tool_result" && b.tool_use_id === call.id);
      if (results.length !== 1) continue;
      const result = results[0];
      let delivered = false;
      if (!result.is_error) {
        try {
          const receipt =
            typeof result.content === "string"
              ? JSON.parse(result.content)
              : result.content;
          delivered =
            receipt?.success === true && receipt?.resumedAgentId === args.to;
        } catch {
          /* A non-JSON result cannot establish delivery. */
        }
      }
      bridges.push({
        id: call.id,
        target: args.to,
        unknown: interrupted(result),
        delivered,
      });
    }
  }
  return bridges
    .filter(
      (b, index) =>
        b.unknown &&
        bridges
          .slice(index + 1)
          .some((next) => next.target === b.target && next.delivered),
    )
    .map((b) => b.id);
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
  rootPath?: string;
  ownerAgentId?: string;
  parentResolved?: boolean;
  dependencies?: string[];
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
  async root(): Promise<ChildCheckpoint> {
    const matches: string[] = [];
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const path = join(this.directory, entry.name, this.sessionId + ".jsonl");
      try {
        await lstat(path);
        matches.push(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (matches.length !== 1)
      throw new Error("Expected one original native session");
    const path = matches[0],
      rows = await read(path);
    const unresolved = pending(rows).filter(
      (c) => c.name !== "Agent" && c.name !== "SendMessage",
    );
    if (unresolved.some((c) => !this.tools.includes(c.name)))
      throw new Error(
        "Unanswered root tool has no configured recovery executor",
      );
    return {
      parentPath: path,
      childPath: path,
      childId: "",
      parent: { id: "", name: "", input: {} },
      calls: calls(rows),
      pending: unresolved,
    };
  }
  async assertRootReady() {
    const root = await this.root();
    if (pending(await read(root.childPath)).length)
      throw new Error(
        "Unresolved native root tool results; refusing model continuation",
      );
  }
  async result(
    checkpoint: ChildCheckpoint,
    id: string,
  ): Promise<(NativeResult & { rawContent: unknown }) | undefined> {
    const results = (await read(checkpoint.childPath))
      .filter((r) => r.type === "user")
      .flatMap(blocks)
      .filter(
        (b) =>
          b.type === "tool_result" && b.tool_use_id === id && !interrupted(b),
      );
    if (results.length > 1) throw new Error("Ambiguous canonical tool results");
    const result = results[0];
    if (!result) return undefined;
    return {
      rawContent: result.content,
      content:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      is_error: !!result.is_error,
    };
  }
  async inspect(): Promise<ChildCheckpoint | undefined> {
    return (await this.children())[0];
  }
  async children(includeCompleted = false): Promise<ChildCheckpoint[]> {
    const root = await this.root();
    const folder = join(dirname(root.childPath), this.sessionId, "subagents");
    let files: string[];
    try {
      files = (await readdir(folder)).filter((n) =>
        /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(n),
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !root.calls.some((c) => c.name === "Agent")
      )
        return [];
      throw error;
    }
    const records = [
      { path: root.childPath, id: "", rows: await read(root.childPath) },
      ...(await Promise.all(
        files.map(async (file) => ({
          path: join(folder, file),
          id: file.slice(6, -6),
          rows: await read(join(folder, file)),
        })),
      )),
    ];
    const checkpoints: ChildCheckpoint[] = [];
    for (const child of records.slice(1)) {
      if (child.rows.some((r) => r.agentId && r.agentId !== child.id))
        throw new Error("Native child identity mismatch");
      let toolId: string | undefined;
      let parentAgentId: string | undefined;
      try {
        const metaPath = child.path.replace(/\.jsonl$/, ".meta.json");
        if ((await lstat(metaPath)).isSymbolicLink())
          throw new Error("Native child metadata must not be a symlink");
        const meta = JSON.parse(await readFile(metaPath, "utf8"));
        toolId = meta.toolUseId;
        parentAgentId = meta.parentAgentId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parents = records.flatMap((owner) =>
        calls(owner.rows)
          .filter(
            (c) =>
              c.name === "Agent" &&
              (toolId ? c.id === toolId : owner.id === ""),
          )
          .map((call) => ({ owner, call })),
      );
      if (parents.length !== 1 || (!toolId && files.length !== 1))
        throw new Error(
          "Expected one child parent identity in native metadata",
        );
      const { owner, call } = parents[0];
      if (owner.id === child.id) throw new Error("Cyclic child identity");
      if (parentAgentId && parentAgentId !== owner.id)
        throw new Error("Native child parent identity mismatch");
      const unfinished = pending(child.rows);
      const unanswered = unfinished.filter((c) => c.name !== "Agent");
      if (unanswered.some((c) => !this.tools.includes(c.name)))
        throw new Error(
          "Unanswered child tool has no configured recovery executor",
        );
      const last = child.rows
        .filter((r) => r.type === "assistant" || r.type === "user")
        .at(-1);
      const final =
        !unfinished.length &&
        last?.type === "assistant" &&
        last.message?.stop_reason === "end_turn"
          ? blocks(last)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n")
          : undefined;
      const parentResolved = !pending(owner.rows).some((c) => c.id === call.id);
      // Completed foreground/background siblings remain completed. A background
      // completion is recorded separately; never overwrite its real launch result.
      const recorded = owner.rows.some(
        (r) => r.agUiRecoveredChildId === child.id,
      );
      if (
        !includeCompleted &&
        parentResolved &&
        final !== undefined &&
        (call.input.run_in_background !== true || recorded)
      )
        continue;
      checkpoints.push({
        rootPath: root.childPath,
        parentPath: owner.path,
        ownerAgentId: owner.id || undefined,
        childPath: child.path,
        childId: child.id,
        parent: call,
        parentResolved,
        pending: unanswered,
        calls: calls(child.rows),
        dependencies: unfinished
          .filter((c) => c.name === "Agent")
          .map((c) => c.id),
        ...(final !== undefined ? { final } : {}),
      });
    }
    for (const record of records)
      for (const call of pending(record.rows).filter((c) => c.name === "Agent"))
        if (!checkpoints.some((c) => c.parent.id === call.id))
          throw new Error(
            "Pending Agent has no recoverable native child identity",
          );
    return checkpoints;
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
    // Retire resolved execution metadata, retaining provenance on the actual result.
    for (const marker of [...rows]) {
      const attachment = marker.attachment as
        | { type?: string; toolUseID?: string }
        | undefined;
      if (
        marker.type !== "attachment" ||
        attachment?.type !== "hook_deferred_tool" ||
        !attachment.toolUseID ||
        !(attachment.toolUseID in results)
      )
        continue;
      if (!marker.uuid) throw new Error("Missing deferred tool ancestry");
      const target = rows.find(
        (r) =>
          r.type === "user" &&
          blocks(r).some((b) => b.tool_use_id === attachment.toolUseID),
      )!;
      target.agUiResolvedDeferrals = [
        ...((target.agUiResolvedDeferrals as Row[]) ?? []),
        structuredClone(marker),
      ];
      for (const row of rows) {
        if (row.parentUuid === marker.uuid) row.parentUuid = marker.parentUuid;
        if (row.leafUuid === marker.uuid) row.leafUuid = marker.parentUuid;
      }
      rows.splice(rows.indexOf(marker), 1);
    }
    await replace(checkpoint.childPath, before, rows);
  }
  async settleBridge(
    checkpoint: ChildCheckpoint,
    results: Record<string, NativeResult>,
  ) {
    const bridgePath = checkpoint.rootPath ?? checkpoint.parentPath;
    const unresolved = pending(await read(bridgePath));
    const missing = Object.fromEntries(
      Object.entries(results).filter(([id]) =>
        unresolved.some((c) => c.id === id),
      ),
    );
    if (Object.keys(missing).length)
      await this.answer({ ...checkpoint, childPath: bridgePath }, missing);
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
    const fresh = (await this.children()).find(
      (c) => c.childId === checkpoint.childId,
    );
    if (
      fresh?.final === undefined ||
      fresh.pending.length ||
      fresh.childId !== checkpoint.childId
    )
      throw new Error("Child has not completed recovery");
    if (
      fresh.rootPath &&
      pending(await read(fresh.rootPath)).some((c) => c.name === "SendMessage")
    )
      throw new Error(
        "Unresolved recovery tool result; parent remains unresolved",
      );
    const before = await read(fresh.parentPath),
      rows = structuredClone(before);
    // A crash may lose the in-memory SendMessage response even after the child
    // finishes. Never repair the Agent and resume with another unanswered call.
    if (
      pending(before).some(
        (call) => call.id !== fresh.parent.id && call.name !== "Agent",
      )
    )
      throw new Error(
        "Unresolved recovery tool result; parent remains unresolved",
      );
    if (fresh.parentResolved) {
      const last = rows.filter((r) => r.uuid).at(-1);
      rows.push({
        agentId: fresh.ownerAgentId,
        isSidechain: !!fresh.ownerAgentId,
        type: "user",
        uuid: randomUUID(),
        parentUuid: last?.uuid ?? null,
        sessionId: this.sessionId,
        version: "2.1.306",
        timestamp: new Date().toISOString(),
        cwd: last?.cwd,
        userType: last?.userType,
        agUiRecoveredChildId: fresh.childId,
        message: {
          role: "user",
          content: `Recovered child ${fresh.childId} completed: ${fresh.final}`,
        },
      });
      await replace(fresh.parentPath, before, rows);
      return;
    }
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
        ...Object.fromEntries(
          ["agentId", "isSidechain", "cwd", "userType", "entrypoint"]
            .filter((k) => k in source)
            .map((k) => [k, source[k]]),
        ),
        type: "user",
        uuid: randomUUID(),
        parentUuid: last.uuid,
        sourceToolAssistantUUID: source.uuid,
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
