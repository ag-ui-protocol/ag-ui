# Subagent Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subagent attribution (`subagentId` on creation/standalone events, carried onto messages) plus optional subagent lifecycle events (`SUBAGENT_STARTED`/`FINISHED`/`ERROR`) to AG-UI, inside one flat run, fully backwards-compatibly.

**Architecture:** Additive optional fields and new event types on the existing flat run lifecycle. TypeScript gets schema + runtime (apply, chunk-transform, verify, subscriber hooks); Python gets a schema mirror only (it is the producer side; apply/verify are client-only).

**Tech Stack:** TypeScript (Zod, RxJS, Vitest), Python (Pydantic v2, unittest).

Design spec: `docs/superpowers/specs/2026-07-07-subagent-support-design.md`.

## Global Constraints

- Every new field and event type is **optional**. No existing producer or consumer may break.
- Attribution is `subagentId` only — an opaque string. No denormalized name/description on messages.
- The run lifecycle (`RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`) is never modified and never carries `subagentId`.
- Wire form is always camelCase `subagentId`. Python uses snake_case `subagent_id` with the existing `alias_generator=to_camel`.
- `subagentId` goes on creation + standalone events only; continuation events inherit via id. `MESSAGES_SNAPSHOT` carries no event-level `subagentId` (it rides inside each message).
- Lifecycle events are **enforced-when-present**: optional, but consistency-checked by the verifier if used.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- TS single-test command: `pnpm test -- <relative-test-path> -t "<test name>"` run from the package dir.
- Python test command: `python -m unittest tests.<module>` run from `sdks/python`.

## File Structure

**TypeScript — `sdks/typescript/packages/core/src/`:**
- `types.ts` — add `subagentId` to message schemas.
- `events.ts` — add `subagentId` to creation/standalone event schemas; add three lifecycle event schemas + enum + union + type maps.
- `event-factories.ts` — factories for the three lifecycle events.

**TypeScript — `sdks/typescript/packages/client/src/`:**
- `apply/default.ts` — copy `subagentId` onto newly created messages; dispatch lifecycle subscriber hooks.
- `chunks/transform.ts` — propagate `subagentId` from chunk events onto synthesized `*_START` events.
- `agent/subscriber.ts` — three optional lifecycle hooks.
- `verify/verify.ts` — enforced-when-present lifecycle checks + closed-subagents-at-`RUN_FINISHED`.

**Python — `sdks/python/ag_ui/core/`:**
- `types.py` — add `subagent_id` to message classes.
- `events.py` — add `subagent_id` to creation/standalone events; add three lifecycle event classes + enum + `Event` union.

---

## Task 1: `subagentId` on TypeScript message schemas

**Files:**
- Modify: `sdks/typescript/packages/core/src/types.ts`
- Test: `sdks/typescript/packages/core/src/__tests__/subagent-attribution.test.ts` (create)

**Interfaces:**
- Produces: optional `subagentId?: string` on `BaseMessageSchema`, `ToolMessageSchema`, `ActivityMessageSchema`, `ReasoningMessageSchema`; exported `Message` type gains `subagentId?: string`.

- [ ] **Step 1: Write the failing test**

Create `sdks/typescript/packages/core/src/__tests__/subagent-attribution.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  MessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
} from "../types";

describe("message subagentId attribution", () => {
  it("accepts subagentId on an assistant message", () => {
    const parsed = AssistantMessageSchema.parse({
      id: "m1",
      role: "assistant",
      content: "hi",
      subagentId: "sub-1",
    });
    expect(parsed.subagentId).toBe("sub-1");
  });

  it("accepts subagentId on tool, activity, and reasoning messages", () => {
    expect(
      ToolMessageSchema.parse({
        id: "t1",
        role: "tool",
        content: "ok",
        toolCallId: "tc1",
        subagentId: "sub-2",
      }).subagentId,
    ).toBe("sub-2");
    expect(
      ActivityMessageSchema.parse({
        id: "a1",
        role: "activity",
        activityType: "x",
        content: {},
        subagentId: "sub-3",
      }).subagentId,
    ).toBe("sub-3");
    expect(
      ReasoningMessageSchema.parse({
        id: "r1",
        role: "reasoning",
        content: "think",
        subagentId: "sub-4",
      }).subagentId,
    ).toBe("sub-4");
  });

  it("treats subagentId as optional (omitted => undefined)", () => {
    const parsed = MessageSchema.parse({ id: "m2", role: "assistant", content: "hi" });
    expect(parsed.subagentId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-attribution.test.ts -t "subagentId"`
Expected: FAIL — Zod strips `subagentId`, so `parsed.subagentId` is `undefined` on the accept cases.

- [ ] **Step 3: Add the field to the message schemas**

In `sdks/typescript/packages/core/src/types.ts`, add `subagentId: z.string().optional()` to `BaseMessageSchema`:

```typescript
export const BaseMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  name: z.string().optional(),
  encryptedValue: z.string().optional(),
  subagentId: z.string().optional(),
});
```

`ToolMessageSchema`, `ActivityMessageSchema`, and `ReasoningMessageSchema` do NOT extend `BaseMessageSchema`, so add the same line to each:

```typescript
export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  error: z.string().optional(),
  encryptedValue: z.string().optional(),
  subagentId: z.string().optional(),
});

export const ActivityMessageSchema = z.object({
  id: z.string(),
  role: z.literal("activity"),
  activityType: z.string(),
  content: z.record(z.any()),
  subagentId: z.string().optional(),
});

export const ReasoningMessageSchema = z.object({
  id: z.string(),
  role: z.literal("reasoning"),
  content: z.string(),
  encryptedValue: z.string().optional(),
  subagentId: z.string().optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-attribution.test.ts -t "subagentId"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sdks/typescript/packages/core/src/types.ts sdks/typescript/packages/core/src/__tests__/subagent-attribution.test.ts
git commit -m "feat(core): add optional subagentId to message schemas"
```

---

## Task 2: `subagentId` on TypeScript creation/standalone event schemas

**Files:**
- Modify: `sdks/typescript/packages/core/src/events.ts`
- Test: `sdks/typescript/packages/core/src/__tests__/subagent-events.test.ts` (create)

**Interfaces:**
- Produces: optional `subagentId?: string` on these event schemas — `TextMessageStartEventSchema`, `TextMessageChunkEventSchema`, `ToolCallStartEventSchema`, `ToolCallChunkEventSchema`, `ToolCallResultEventSchema`, `ReasoningStartEventSchema`, `ReasoningMessageStartEventSchema`, `ActivitySnapshotEventSchema`, `StateSnapshotEventSchema`, `StateDeltaEventSchema`, `StepStartedEventSchema`, `StepFinishedEventSchema`, `CustomEventSchema`, `RawEventSchema`. NOT added to continuation events, `MESSAGES_SNAPSHOT`, or run-lifecycle events.

- [ ] **Step 1: Write the failing test**

Create `sdks/typescript/packages/core/src/__tests__/subagent-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  TextMessageStartEventSchema,
  ToolCallStartEventSchema,
  ToolCallResultEventSchema,
  StateDeltaEventSchema,
  StepStartedEventSchema,
  CustomEventSchema,
  EventType,
} from "../events";

describe("event subagentId attribution", () => {
  it("accepts subagentId on creation events", () => {
    expect(
      TextMessageStartEventSchema.parse({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        subagentId: "sub-1",
      }).subagentId,
    ).toBe("sub-1");
    expect(
      ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentId: "sub-2",
      }).subagentId,
    ).toBe("sub-2");
    expect(
      ToolCallResultEventSchema.parse({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm1",
        toolCallId: "tc1",
        content: "done",
        subagentId: "sub-3",
      }).subagentId,
    ).toBe("sub-3");
  });

  it("accepts subagentId on standalone events", () => {
    expect(
      StateDeltaEventSchema.parse({
        type: EventType.STATE_DELTA,
        delta: [],
        subagentId: "sub-4",
      }).subagentId,
    ).toBe("sub-4");
    expect(
      StepStartedEventSchema.parse({
        type: EventType.STEP_STARTED,
        stepName: "s",
        subagentId: "sub-5",
      }).subagentId,
    ).toBe("sub-5");
    expect(
      CustomEventSchema.parse({
        type: EventType.CUSTOM,
        name: "n",
        value: 1,
        subagentId: "sub-6",
      }).subagentId,
    ).toBe("sub-6");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-events.test.ts -t "subagentId"`
Expected: FAIL — `BaseEventSchema` passthrough keeps the key, but `.parse()` on `.extend()`ed schemas without the field... note passthrough DOES keep it, so this may PASS already. If it PASSES at Step 2, that confirms passthrough behavior; still add the explicit field in Step 3 for typing and to make the field first-class (typed on `*Event` types), then keep the test green.

- [ ] **Step 3: Add `subagentId` to the classified event schemas**

In `sdks/typescript/packages/core/src/events.ts`, add `subagentId: z.string().optional(),` to each of these schemas (creation + standalone only):

```typescript
// TextMessageStartEventSchema
export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: TextMessageRoleSchema.default("assistant"),
  name: z.string().optional(),
  subagentId: z.string().optional(),
});
```

Apply the identical `subagentId: z.string().optional(),` line to: `TextMessageChunkEventSchema`, `ToolCallStartEventSchema`, `ToolCallChunkEventSchema`, `ToolCallResultEventSchema`, `ReasoningStartEventSchema`, `ReasoningMessageStartEventSchema`, `ActivitySnapshotEventSchema`, `StateSnapshotEventSchema`, `StateDeltaEventSchema`, `StepStartedEventSchema`, `StepFinishedEventSchema`, `CustomEventSchema`, `RawEventSchema`.

Do NOT add it to: `TextMessageContentEventSchema`, `TextMessageEndEventSchema`, `ToolCallArgsEventSchema`, `ToolCallEndEventSchema`, `ReasoningMessageContentEventSchema`, `ReasoningMessageEndEventSchema`, `ReasoningEndEventSchema`, `ActivityDeltaEventSchema`, `ReasoningEncryptedValueEventSchema`, `MessagesSnapshotEventSchema`, `RunStartedEventSchema`, `RunFinishedEventSchema`, `RunErrorEventSchema`, and the deprecated `Thinking*` schemas.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-events.test.ts -t "subagentId"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sdks/typescript/packages/core/src/events.ts sdks/typescript/packages/core/src/__tests__/subagent-events.test.ts
git commit -m "feat(core): add optional subagentId to creation/standalone events"
```

---

## Task 3: TypeScript subagent lifecycle event types + factories

**Files:**
- Modify: `sdks/typescript/packages/core/src/events.ts`
- Modify: `sdks/typescript/packages/core/src/event-factories.ts`
- Test: `sdks/typescript/packages/core/src/__tests__/subagent-lifecycle-events.test.ts` (create)

**Interfaces:**
- Produces: `EventType.SUBAGENT_STARTED`/`SUBAGENT_FINISHED`/`SUBAGENT_ERROR`; schemas `SubagentStartedEventSchema` (`subagentId: string`, `name: string`, `description?: string`, `parentSubagentId?: string`), `SubagentFinishedEventSchema` (`subagentId: string`), `SubagentErrorEventSchema` (`subagentId: string`, `message: string`, `code?: string`); inferred types `SubagentStartedEvent`/`SubagentFinishedEvent`/`SubagentErrorEvent`; factories `createSubagentStartedEvent`/`createSubagentFinishedEvent`/`createSubagentErrorEvent`; membership in `EventSchemas` union and `AGUIEventByType`.

- [ ] **Step 1: Write the failing test**

Create `sdks/typescript/packages/core/src/__tests__/subagent-lifecycle-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EventType, EventSchemas } from "../events";
import {
  createSubagentStartedEvent,
  createSubagentFinishedEvent,
  createSubagentErrorEvent,
} from "../event-factories";

describe("subagent lifecycle events", () => {
  it("creates and validates SUBAGENT_STARTED with parent", () => {
    const e = createSubagentStartedEvent({
      subagentId: "sub-1",
      name: "Researcher",
      description: "does research",
      parentSubagentId: "sub-0",
    });
    expect(e.type).toBe(EventType.SUBAGENT_STARTED);
    expect(() => EventSchemas.parse(e)).not.toThrow();
    expect(e.subagentId).toBe("sub-1");
    expect(e.parentSubagentId).toBe("sub-0");
  });

  it("creates SUBAGENT_FINISHED and SUBAGENT_ERROR", () => {
    const fin = createSubagentFinishedEvent({ subagentId: "sub-1" });
    expect(fin.type).toBe(EventType.SUBAGENT_FINISHED);
    const err = createSubagentErrorEvent({
      subagentId: "sub-1",
      message: "boom",
      code: "E1",
    });
    expect(err.type).toBe(EventType.SUBAGENT_ERROR);
    expect(err.message).toBe("boom");
    expect(() => EventSchemas.parse(fin)).not.toThrow();
    expect(() => EventSchemas.parse(err)).not.toThrow();
  });

  it("requires name on SUBAGENT_STARTED and message on SUBAGENT_ERROR", () => {
    expect(() =>
      EventSchemas.parse({ type: EventType.SUBAGENT_STARTED, subagentId: "s" }),
    ).toThrow();
    expect(() =>
      EventSchemas.parse({ type: EventType.SUBAGENT_ERROR, subagentId: "s" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-lifecycle-events.test.ts -t "subagent lifecycle"`
Expected: FAIL — factories and enum members do not exist (import/compile error).

- [ ] **Step 3: Add enum members, schemas, union/type-map, and inferred types**

In `sdks/typescript/packages/core/src/events.ts`:

Add to the `EventType` enum (after `REASONING_ENCRYPTED_VALUE`):

```typescript
  SUBAGENT_STARTED = "SUBAGENT_STARTED",
  SUBAGENT_FINISHED = "SUBAGENT_FINISHED",
  SUBAGENT_ERROR = "SUBAGENT_ERROR",
```

Add the schemas (after `ReasoningEncryptedValueEventSchema`):

```typescript
export const SubagentStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_STARTED),
  subagentId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  parentSubagentId: z.string().optional(),
});

export const SubagentFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_FINISHED),
  subagentId: z.string(),
});

export const SubagentErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_ERROR),
  subagentId: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
```

Add all three to the `EventSchemas` discriminated union array (after `ReasoningEncryptedValueEventSchema`):

```typescript
  SubagentStartedEventSchema,
  SubagentFinishedEventSchema,
  SubagentErrorEventSchema,
```

Add to `AGUIEventByType` (after the `REASONING_ENCRYPTED_VALUE` entry):

```typescript
  [EventType.SUBAGENT_STARTED]: SubagentStartedEvent;
  [EventType.SUBAGENT_FINISHED]: SubagentFinishedEvent;
  [EventType.SUBAGENT_ERROR]: SubagentErrorEvent;
```

Add the `*Props` exports (with the other `*Props`):

```typescript
export type SubagentStartedEventProps = EventProps<typeof SubagentStartedEventSchema>;
export type SubagentFinishedEventProps = EventProps<typeof SubagentFinishedEventSchema>;
export type SubagentErrorEventProps = EventProps<typeof SubagentErrorEventSchema>;
```

Add the inferred type exports (with the other `z.infer` types):

```typescript
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;
export type SubagentFinishedEvent = z.infer<typeof SubagentFinishedEventSchema>;
export type SubagentErrorEvent = z.infer<typeof SubagentErrorEventSchema>;
```

- [ ] **Step 4: Add factories**

In `sdks/typescript/packages/core/src/event-factories.ts`, add the imports (in the existing import block from `./events`): `SubagentStartedEvent, SubagentStartedEventProps, SubagentStartedEventSchema, SubagentFinishedEvent, SubagentFinishedEventProps, SubagentFinishedEventSchema, SubagentErrorEvent, SubagentErrorEventProps, SubagentErrorEventSchema`. Then append the factories:

```typescript
/**
 * Creates a SUBAGENT_STARTED event.
 */
export const createSubagentStartedEvent = (
  props: SubagentStartedEventProps,
): SubagentStartedEvent =>
  buildEvent(EventType.SUBAGENT_STARTED, SubagentStartedEventSchema, props);

/**
 * Creates a SUBAGENT_FINISHED event.
 */
export const createSubagentFinishedEvent = (
  props: SubagentFinishedEventProps,
): SubagentFinishedEvent =>
  buildEvent(EventType.SUBAGENT_FINISHED, SubagentFinishedEventSchema, props);

/**
 * Creates a SUBAGENT_ERROR event.
 */
export const createSubagentErrorEvent = (
  props: SubagentErrorEventProps,
): SubagentErrorEvent =>
  buildEvent(EventType.SUBAGENT_ERROR, SubagentErrorEventSchema, props);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd sdks/typescript/packages/core && pnpm test -- src/__tests__/subagent-lifecycle-events.test.ts -t "subagent lifecycle"`
Expected: PASS

- [ ] **Step 6: Run the full core test suite + type check**

Run: `cd sdks/typescript/packages/core && pnpm test && pnpm check-types`
Expected: PASS (confirms the union/type-map additions compile and no existing test broke).

- [ ] **Step 7: Commit**

```bash
git add sdks/typescript/packages/core/src/events.ts sdks/typescript/packages/core/src/event-factories.ts sdks/typescript/packages/core/src/__tests__/subagent-lifecycle-events.test.ts
git commit -m "feat(core): add SUBAGENT_STARTED/FINISHED/ERROR lifecycle events"
```

---

## Task 4: Copy `subagentId` onto created messages in `defaultApplyEvents`

**Files:**
- Modify: `sdks/typescript/packages/client/src/apply/default.ts`
- Test: `sdks/typescript/packages/client/src/apply/__tests__/subagent-apply.test.ts` (create; confirm the `__tests__` dir convention below in Step 1)

**Interfaces:**
- Consumes: `subagentId` on creation events (Task 2) and message schemas (Task 1).
- Produces: created messages carry `event.subagentId`; the copy happens only on message *creation*, never overwriting a pre-existing message's `subagentId`.

- [ ] **Step 1: Locate the client apply test convention and write the failing test**

First confirm where client tests live: `ls sdks/typescript/packages/client/src/apply/__tests__ 2>/dev/null || ls sdks/typescript/packages/client/src/__tests__`. Create the test alongside existing apply tests (use the directory that exists; if neither, create `sdks/typescript/packages/client/src/apply/__tests__/`).

Create `subagent-apply.test.ts` there:

```typescript
import { describe, it, expect } from "vitest";
import { firstValueFrom, from, toArray, lastValueFrom } from "rxjs";
import { EventType, type RunAgentInput, type BaseEvent, type Message } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent/agent";

// Minimal agent stub with empty starting messages.
function makeAgent(): AbstractAgent {
  return { messages: [] as Message[] } as unknown as AbstractAgent;
}

function makeInput(): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

async function applyAll(events: BaseEvent[]): Promise<Message[]> {
  const mutations = await lastValueFrom(
    from(events).pipe(() => defaultApplyEvents(makeInput(), from(events), makeAgent(), []).pipe(toArray())),
  );
  const last = mutations[mutations.length - 1];
  return (last.messages ?? []) as Message[];
}

describe("subagentId apply-time transfer", () => {
  it("copies subagentId from TEXT_MESSAGE_START onto the created message", async () => {
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentId: "sub-1" } as any,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello" } as any,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as any,
    ];
    const messages = await applyAll(events);
    const m = messages.find((x) => x.id === "m1");
    expect(m?.subagentId).toBe("sub-1");
    expect(m?.content).toBe("hello");
  });

  it("copies subagentId from TOOL_CALL_RESULT onto the created tool message", async () => {
    const events: BaseEvent[] = [
      { type: EventType.TOOL_CALL_RESULT, messageId: "tm1", toolCallId: "tc1", content: "done", subagentId: "sub-2" } as any,
    ];
    const messages = await applyAll(events);
    const m = messages.find((x) => x.id === "tm1");
    expect(m?.subagentId).toBe("sub-2");
  });

  it("does not overwrite subagentId on a pre-existing message", async () => {
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant", subagentId: "owner" } as any,
      // A tool call that resolves to the same message id via parentMessageId must NOT change owner.
      { type: EventType.TOOL_CALL_START, toolCallId: "tc9", toolCallName: "f", parentMessageId: "m2", subagentId: "intruder" } as any,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc9" } as any,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m2" } as any,
    ];
    const messages = await applyAll(events);
    const m = messages.find((x) => x.id === "m2");
    expect(m?.subagentId).toBe("owner");
  });
});
```

> Note: if the `applyAll` helper's RxJS wiring does not match the repo's existing apply-test style, mirror the exact harness used by a sibling test in the same `__tests__` dir (import it and copy its subscribe/collect pattern). The assertions above are the contract that must hold.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/client && pnpm test -- <path-to>/subagent-apply.test.ts -t "subagentId apply-time"`
Expected: FAIL — created messages have `subagentId === undefined`.

- [ ] **Step 3: Set `subagentId` on message creation (TEXT_MESSAGE_START)**

In `apply/default.ts`, in the `TEXT_MESSAGE_START` case, extend the new-message construction (currently around lines 171–188):

```typescript
const { messageId, role = "assistant", name, subagentId } = event as TextMessageStartEvent;

const existingMessage = messages.find((m) => m.id === messageId);

if (!existingMessage) {
  const newMessage: Message = {
    id: messageId,
    role: role,
    content: "",
    ...(name !== undefined && { name }),
    ...(subagentId !== undefined && { subagentId }),
  };
  messages.push(newMessage);
  applyMutation({ messages });
}
```

- [ ] **Step 4: Set `subagentId` for TOOL_CALL_START (only when the assistant message is newly created)**

In the `TOOL_CALL_START` case, `resolveOrCreateAssistantMessage` may return an existing or new message. Detect creation by checking existence *before* the call, then set `subagentId` only if it was created and the event carries one. Replace the resolve block (around lines 294–316):

```typescript
const { toolCallId, toolCallName, parentMessageId, subagentId } = event as ToolCallStartEvent;

const preexistingIds = new Set(messages.map((m) => m.id));
const targetMessage = resolveOrCreateAssistantMessage(messages, parentMessageId, toolCallId);
const wasCreated = !preexistingIds.has(targetMessage.id);
if (wasCreated && subagentId !== undefined && targetMessage.subagentId === undefined) {
  targetMessage.subagentId = subagentId;
}

targetMessage.toolCalls ??= [];
targetMessage.toolCalls.push({
  id: toolCallId,
  type: "function",
  function: { name: toolCallName, arguments: "" },
});
applyMutation({ messages });
```

- [ ] **Step 5: Set `subagentId` for TOOL_CALL_RESULT, REASONING_MESSAGE_START, and ACTIVITY_SNAPSHOT created messages**

For each of these cases in `apply/default.ts`, locate where the new message object is constructed and add `...(subagentId !== undefined && { subagentId })` (destructuring `subagentId` from the event), guarded so it applies only when a NEW message is created (mirror each case's existing "does this message already exist?" check):

- `TOOL_CALL_RESULT` (around line 439): the tool message is created here — set `subagentId` from `(event as ToolCallResultEvent).subagentId` on the new tool message.
- `REASONING_MESSAGE_START` (around line 988): set `subagentId` from `(event as ReasoningMessageStartEvent).subagentId` on the new reasoning message.
- `ACTIVITY_SNAPSHOT` (around line 637): set `subagentId` from `(event as ActivitySnapshotEvent).subagentId` on the newly created activity message (only when it creates, not when it replaces an existing one — follow the case's existing create-vs-update branch).

For each, only set the field when the message is being created and its `subagentId` is currently undefined (do not overwrite).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd sdks/typescript/packages/client && pnpm test -- <path-to>/subagent-apply.test.ts -t "subagentId apply-time"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add sdks/typescript/packages/client/src/apply/default.ts <path-to>/subagent-apply.test.ts
git commit -m "feat(client): carry subagentId from creation events onto messages"
```

---

## Task 5: Propagate `subagentId` through `transformChunks`

**Files:**
- Modify: `sdks/typescript/packages/client/src/chunks/transform.ts`
- Test: `sdks/typescript/packages/client/src/chunks/__tests__/subagent-chunks.test.ts` (create; confirm dir as in Task 4 Step 1)

**Interfaces:**
- Consumes: `subagentId` on `TextMessageChunkEvent` / `ToolCallChunkEvent` (Task 2).
- Produces: synthesized `TEXT_MESSAGE_START` / `TOOL_CALL_START` events carry the chunk's `subagentId`, so chunk-based producers attribute messages identically to explicit-start producers.

- [ ] **Step 1: Write the failing test**

Create `subagent-chunks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { from, toArray, lastValueFrom } from "rxjs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { transformChunks } from "../transform";

async function run(events: BaseEvent[]): Promise<BaseEvent[]> {
  return lastValueFrom(from(events).pipe(transformChunks(), toArray()));
}

describe("transformChunks subagentId propagation", () => {
  it("carries subagentId onto synthesized TEXT_MESSAGE_START", async () => {
    const out = await run([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: "assistant", delta: "hi", subagentId: "sub-1" } as any,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as any,
    ]);
    const start = out.find((e) => e.type === EventType.TEXT_MESSAGE_START) as any;
    expect(start?.subagentId).toBe("sub-1");
  });

  it("carries subagentId onto synthesized TOOL_CALL_START", async () => {
    const out = await run([
      { type: EventType.TOOL_CALL_CHUNK, toolCallId: "tc1", toolCallName: "f", delta: "{}", subagentId: "sub-2" } as any,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as any,
    ]);
    const start = out.find((e) => e.type === EventType.TOOL_CALL_START) as any;
    expect(start?.subagentId).toBe("sub-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/client && pnpm test -- src/chunks/__tests__/subagent-chunks.test.ts -t "subagentId propagation"`
Expected: FAIL — synthesized start events omit `subagentId`.

- [ ] **Step 3: Thread `subagentId` through the transform state and start events**

In `chunks/transform.ts`, add `subagentId?: string` to the `TextMessageFields`, `ToolCallFields`, and `ReasoningMessageFields` interfaces:

```typescript
interface TextMessageFields {
  messageId: string;
  name?: string;
  subagentId?: string;
}
interface ToolCallFields {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  subagentId?: string;
}
interface ReasoningMessageFields {
  messageId: string;
  subagentId?: string;
}
```

In the `TEXT_MESSAGE_CHUNK` branch, capture and emit it — set `textMessageFields = { messageId, name, subagentId: messageChunkEvent.subagentId }` and add `...(messageChunkEvent.subagentId !== undefined && { subagentId: messageChunkEvent.subagentId })` to the `textMessageStartEvent` object literal.

In the `TOOL_CALL_CHUNK` branch, set `toolCallFields = { toolCallId, toolCallName, parentMessageId, subagentId: toolCallChunkEvent.subagentId }` and add `...(toolCallChunkEvent.subagentId !== undefined && { subagentId: toolCallChunkEvent.subagentId })` to the synthesized `toolCallStartEvent` object literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdks/typescript/packages/client && pnpm test -- src/chunks/__tests__/subagent-chunks.test.ts -t "subagentId propagation"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sdks/typescript/packages/client/src/chunks/transform.ts sdks/typescript/packages/client/src/chunks/__tests__/subagent-chunks.test.ts
git commit -m "feat(client): propagate subagentId through chunk transform"
```

---

## Task 6: Subagent lifecycle subscriber hooks + apply dispatch

**Files:**
- Modify: `sdks/typescript/packages/client/src/agent/subscriber.ts`
- Modify: `sdks/typescript/packages/client/src/apply/default.ts`
- Test: `sdks/typescript/packages/client/src/apply/__tests__/subagent-lifecycle-hooks.test.ts` (create)

**Interfaces:**
- Consumes: `SubagentStartedEvent`/`SubagentFinishedEvent`/`SubagentErrorEvent` (Task 3).
- Produces: optional `AgentSubscriber` hooks `onSubagentStartedEvent`/`onSubagentFinishedEvent`/`onSubagentErrorEvent`, each `(params: { event: <Event> } & AgentSubscriberParams) => MaybePromise<AgentStateMutation | void>`. `defaultApplyEvents` invokes them on the matching event and performs no message/state mutation of its own for these events.

- [ ] **Step 1: Write the failing test**

Create `subagent-lifecycle-hooks.test.ts` (reuse the apply harness pattern from Task 4):

```typescript
import { describe, it, expect, vi } from "vitest";
import { from, toArray, lastValueFrom } from "rxjs";
import { EventType, type RunAgentInput, type BaseEvent, type Message } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import type { AgentSubscriber } from "@/agent/subscriber";
import { AbstractAgent } from "@/agent/agent";

const agent = { messages: [] as Message[] } as unknown as AbstractAgent;
const input: RunAgentInput = {
  threadId: "t", runId: "r", state: {}, messages: [], tools: [], context: [], forwardedProps: {},
};

describe("subagent lifecycle subscriber dispatch", () => {
  it("invokes onSubagentStartedEvent/Finished/Error", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const errored = vi.fn();
    const sub: AgentSubscriber = {
      onSubagentStartedEvent: started,
      onSubagentFinishedEvent: finished,
      onSubagentErrorEvent: errored,
    };
    const events: BaseEvent[] = [
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "R" } as any,
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "x" } as any,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
    ];
    await lastValueFrom(defaultApplyEvents(input, from(events), agent, [sub]).pipe(toArray()));
    expect(started).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
    expect(errored).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/client && pnpm test -- <path-to>/subagent-lifecycle-hooks.test.ts -t "subagent lifecycle subscriber"`
Expected: FAIL — hooks are never called (and the type may not exist yet).

- [ ] **Step 3: Add the three optional hooks to `AgentSubscriber`**

In `agent/subscriber.ts`, import the three event types from `@ag-ui/core` (add to the existing import), then add near the other event hooks (e.g. after `onCustomEvent`):

```typescript
  onSubagentStartedEvent?(
    params: { event: SubagentStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentFinishedEvent?(
    params: { event: SubagentFinishedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentErrorEvent?(
    params: { event: SubagentErrorEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
```

- [ ] **Step 4: Dispatch the hooks in `defaultApplyEvents`**

In `apply/default.ts`, import the three event types, then add three cases to the switch (before `default:`), mirroring the no-mutation cases like `RAW`:

```typescript
        case EventType.SUBAGENT_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers, messages, state,
            (subscriber, messages, state) =>
              subscriber.onSubagentStartedEvent?.({
                event: event as SubagentStartedEvent, messages, state, agent, input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }
        case EventType.SUBAGENT_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers, messages, state,
            (subscriber, messages, state) =>
              subscriber.onSubagentFinishedEvent?.({
                event: event as SubagentFinishedEvent, messages, state, agent, input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }
        case EventType.SUBAGENT_ERROR: {
          const mutation = await runSubscribersWithMutation(
            subscribers, messages, state,
            (subscriber, messages, state) =>
              subscriber.onSubagentErrorEvent?.({
                event: event as SubagentErrorEvent, messages, state, agent, input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd sdks/typescript/packages/client && pnpm test -- <path-to>/subagent-lifecycle-hooks.test.ts -t "subagent lifecycle subscriber"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add sdks/typescript/packages/client/src/agent/subscriber.ts sdks/typescript/packages/client/src/apply/default.ts <path-to>/subagent-lifecycle-hooks.test.ts
git commit -m "feat(client): add subagent lifecycle subscriber hooks"
```

---

## Task 7: Enforced-when-present lifecycle verification

**Files:**
- Modify: `sdks/typescript/packages/client/src/verify/verify.ts`
- Test: `sdks/typescript/packages/client/src/verify/__tests__/subagent-verify.test.ts` (create; confirm dir convention as in Task 4)

**Interfaces:**
- Consumes: lifecycle events (Task 3).
- Produces: verifier that (a) throws on duplicate `SUBAGENT_STARTED` for the same id, (b) throws on `SUBAGENT_FINISHED`/`SUBAGENT_ERROR` with no matching prior `STARTED`, (c) throws on `SUBAGENT_STARTED` with a `parentSubagentId` that has not been started, (d) throws on `RUN_FINISHED` while any subagent is still open, and (e) passes streams that use no lifecycle events. Per-run state resets in `resetRunState`.

- [ ] **Step 1: Write the failing test**

Create `subagent-verify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { from, toArray, lastValueFrom } from "rxjs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { verifyEvents } from "../verify";

function verify(events: BaseEvent[]) {
  return lastValueFrom(from(events).pipe(verifyEvents(), toArray()));
}
const started = (id: string, name = "n", parent?: string) =>
  ({ type: EventType.SUBAGENT_STARTED, subagentId: id, name, ...(parent && { parentSubagentId: parent }) }) as any;

describe("subagent lifecycle verification", () => {
  it("accepts a well-formed subagent lifecycle within a run", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        started("s1"),
        { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as any,
      ]),
    ).resolves.toBeDefined();
  });

  it("rejects duplicate SUBAGENT_STARTED", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        started("s1"),
        started("s1"),
      ]),
    ).rejects.toThrow(/already/i);
  });

  it("rejects SUBAGENT_FINISHED with no matching start", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        { type: EventType.SUBAGENT_FINISHED, subagentId: "ghost" } as any,
      ]),
    ).rejects.toThrow(/not started|no active|matching/i);
  });

  it("rejects unknown parentSubagentId", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        started("child", "n", "missing-parent"),
      ]),
    ).rejects.toThrow(/parent/i);
  });

  it("rejects RUN_FINISHED while a subagent is still open", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        started("s1"),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as any,
      ]),
    ).rejects.toThrow(/subagent/i);
  });

  it("passes a stream with no lifecycle events", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as any,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as any,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as any,
      ]),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/typescript/packages/client && pnpm test -- src/verify/__tests__/subagent-verify.test.ts -t "subagent lifecycle verification"`
Expected: FAIL — no lifecycle handling; error cases resolve instead of rejecting, and the open-subagent-at-RUN_FINISHED case passes.

- [ ] **Step 3: Add active-subagent tracking state**

In `verify/verify.ts`, add to the closure state (near `activeSteps`):

```typescript
    let activeSubagents = new Map<string, boolean>(); // subagentId -> active
```

Add to `resetRunState`:

```typescript
      activeSubagents.clear();
```

- [ ] **Step 4: Add the three lifecycle cases**

Add these cases to the switch (before `default:`):

```typescript
          case EventType.SUBAGENT_STARTED: {
            const subagentId = (event as any).subagentId;
            const parentSubagentId = (event as any).parentSubagentId;
            if (activeSubagents.has(subagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': subagent '${subagentId}' is already active. Finish it with 'SUBAGENT_FINISHED' first.`,
                  ),
              );
            }
            if (parentSubagentId !== undefined && !activeSubagents.has(parentSubagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': parentSubagentId '${parentSubagentId}' has not been started.`,
                  ),
              );
            }
            activeSubagents.set(subagentId, true);
            return of(event);
          }

          case EventType.SUBAGENT_FINISHED:
          case EventType.SUBAGENT_ERROR: {
            const subagentId = (event as any).subagentId;
            if (!activeSubagents.has(subagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send '${eventType}': no active subagent found with ID '${subagentId}'. A 'SUBAGENT_STARTED' event must be sent first.`,
                  ),
              );
            }
            activeSubagents.delete(subagentId);
            return of(event);
          }
```

- [ ] **Step 5: Enforce closed subagents at `RUN_FINISHED`**

In the `RUN_FINISHED` case, after the existing active-tool-calls check and before `runFinished = true;`, add:

```typescript
            if (activeSubagents.size > 0) {
              const unfinishedSubagents = Array.from(activeSubagents.keys()).join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while subagents are still active: ${unfinishedSubagents}`,
                  ),
              );
            }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd sdks/typescript/packages/client && pnpm test -- src/verify/__tests__/subagent-verify.test.ts -t "subagent lifecycle verification"`
Expected: PASS

- [ ] **Step 7: Run the full client suite + type check**

Run: `cd sdks/typescript/packages/client && pnpm test && pnpm check-types`
Expected: PASS (no existing verify/apply/transform test regressed).

- [ ] **Step 8: Commit**

```bash
git add sdks/typescript/packages/client/src/verify/verify.ts sdks/typescript/packages/client/src/verify/__tests__/subagent-verify.test.ts
git commit -m "feat(client): enforce subagent lifecycle consistency in verifier"
```

---

## Task 8: `subagent_id` on Python message types

**Files:**
- Modify: `sdks/python/ag_ui/core/types.py`
- Test: `sdks/python/tests/test_subagent.py` (create)

**Interfaces:**
- Produces: optional `subagent_id: Optional[str] = None` on `BaseMessage`, `ToolMessage`, `ActivityMessage`, `ReasoningMessage`, serialized as `subagentId` via the existing `alias_generator=to_camel`.

- [ ] **Step 1: Write the failing test**

Create `sdks/python/tests/test_subagent.py`:

```python
import unittest

from ag_ui.core.types import AssistantMessage, ToolMessage, ReasoningMessage


class TestSubagentMessageAttribution(unittest.TestCase):
    def test_assistant_message_accepts_subagent_id(self):
        msg = AssistantMessage(id="m1", role="assistant", content="hi", subagent_id="sub-1")
        self.assertEqual(msg.subagent_id, "sub-1")
        self.assertEqual(msg.model_dump(by_alias=True)["subagentId"], "sub-1")

    def test_tool_and_reasoning_messages_accept_subagent_id(self):
        tool = ToolMessage(id="t1", role="tool", content="ok", tool_call_id="tc1", subagent_id="sub-2")
        self.assertEqual(tool.subagent_id, "sub-2")
        reasoning = ReasoningMessage(id="r1", role="reasoning", content="x", subagent_id="sub-3")
        self.assertEqual(reasoning.subagent_id, "sub-3")

    def test_subagent_id_optional(self):
        msg = AssistantMessage(id="m2", role="assistant", content="hi")
        self.assertIsNone(msg.subagent_id)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdks/python && python -m unittest tests.test_subagent -v`
Expected: FAIL — `subagent_id` is not a declared field. (Note: `extra="allow"` stores it, but `model_dump(by_alias=True)` will not emit `subagentId` for an undeclared field, and `.subagent_id` attribute access differs — the explicit field makes it first-class.)

- [ ] **Step 3: Add the field to the message classes**

In `sdks/python/ag_ui/core/types.py`, add `subagent_id: Optional[str] = None` to `BaseMessage`:

```python
class BaseMessage(ConfiguredBaseModel):
    id: str
    role: str
    content: Optional[str] = None
    name: Optional[str] = None
    encrypted_value: Optional[str] = None
    subagent_id: Optional[str] = None
```

`ToolMessage`, `ActivityMessage`, and `ReasoningMessage` do not extend `BaseMessage` — add the same `subagent_id: Optional[str] = None` line to each of those class bodies. (Confirm `Optional` is already imported in `types.py`; it is used elsewhere in the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdks/python && python -m unittest tests.test_subagent -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sdks/python/ag_ui/core/types.py sdks/python/tests/test_subagent.py
git commit -m "feat(python): add optional subagent_id to message types"
```

---

## Task 9: Python event `subagent_id` + lifecycle events

**Files:**
- Modify: `sdks/python/ag_ui/core/events.py`
- Test: `sdks/python/tests/test_subagent.py` (extend)

**Interfaces:**
- Consumes: message field (Task 8).
- Produces: optional `subagent_id: Optional[str] = None` on the classified creation/standalone event classes; `EventType.SUBAGENT_STARTED`/`SUBAGENT_FINISHED`/`SUBAGENT_ERROR`; classes `SubagentStartedEvent` (`subagent_id: str`, `name: str`, `description: Optional[str]`, `parent_subagent_id: Optional[str]`), `SubagentFinishedEvent` (`subagent_id: str`), `SubagentErrorEvent` (`subagent_id: str`, `message: str`, `code: Optional[str]`); membership in the `Event` discriminated union.

- [ ] **Step 1: Add failing tests (extend the file)**

Append to `sdks/python/tests/test_subagent.py`:

```python
from ag_ui.core.events import (
    EventType,
    TextMessageStartEvent,
    StateDeltaEvent,
    SubagentStartedEvent,
    SubagentFinishedEvent,
    SubagentErrorEvent,
)


class TestSubagentEventAttribution(unittest.TestCase):
    def test_creation_and_standalone_events_accept_subagent_id(self):
        e = TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_id="sub-1")
        self.assertEqual(e.subagent_id, "sub-1")
        self.assertEqual(e.model_dump(by_alias=True)["subagentId"], "sub-1")
        d = StateDeltaEvent(type=EventType.STATE_DELTA, delta=[], subagent_id="sub-2")
        self.assertEqual(d.subagent_id, "sub-2")


class TestSubagentLifecycleEvents(unittest.TestCase):
    def test_started_finished_error(self):
        s = SubagentStartedEvent(
            type=EventType.SUBAGENT_STARTED, subagent_id="s1", name="R",
            description="d", parent_subagent_id="s0",
        )
        self.assertEqual(s.type, EventType.SUBAGENT_STARTED)
        self.assertEqual(s.parent_subagent_id, "s0")
        f = SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_id="s1")
        self.assertEqual(f.type, EventType.SUBAGENT_FINISHED)
        err = SubagentErrorEvent(type=EventType.SUBAGENT_ERROR, subagent_id="s1", message="boom", code="E1")
        self.assertEqual(err.message, "boom")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sdks/python && python -m unittest tests.test_subagent -v`
Expected: FAIL — lifecycle event classes and (typed) `subagent_id` not present (ImportError / attribute mismatch).

- [ ] **Step 3: Add enum members**

In `sdks/python/ag_ui/core/events.py`, add to the `EventType` enum:

```python
    SUBAGENT_STARTED = "SUBAGENT_STARTED"
    SUBAGENT_FINISHED = "SUBAGENT_FINISHED"
    SUBAGENT_ERROR = "SUBAGENT_ERROR"
```

- [ ] **Step 4: Add `subagent_id` to the classified event classes**

Add `subagent_id: Optional[str] = None` to each of these event classes only: `TextMessageStartEvent`, `TextMessageChunkEvent`, `ToolCallStartEvent`, `ToolCallChunkEvent`, `ToolCallResultEvent`, `ReasoningStartEvent`, `ReasoningMessageStartEvent`, `ActivitySnapshotEvent`, `StateSnapshotEvent`, `StateDeltaEvent`, `StepStartedEvent`, `StepFinishedEvent`, `CustomEvent`, `RawEvent`. (Do NOT add to continuation events, `MessagesSnapshotEvent`, or run-lifecycle events.)

Example:

```python
class TextMessageStartEvent(BaseEvent):
    type: Literal[EventType.TEXT_MESSAGE_START] = EventType.TEXT_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    role: TextMessageRole = "assistant"
    name: Optional[str] = None
    subagent_id: Optional[str] = None
```

- [ ] **Step 5: Add the three lifecycle event classes**

Add after the reasoning event classes (before the `Event` union):

```python
class SubagentStartedEvent(BaseEvent):
    """Event indicating a subagent has started within the run."""
    type: Literal[EventType.SUBAGENT_STARTED] = EventType.SUBAGENT_STARTED  # pyright: ignore[reportIncompatibleVariableOverride]
    subagent_id: str
    name: str
    description: Optional[str] = None
    parent_subagent_id: Optional[str] = None


class SubagentFinishedEvent(BaseEvent):
    """Event indicating a subagent has finished."""
    type: Literal[EventType.SUBAGENT_FINISHED] = EventType.SUBAGENT_FINISHED  # pyright: ignore[reportIncompatibleVariableOverride]
    subagent_id: str


class SubagentErrorEvent(BaseEvent):
    """Event indicating a subagent has errored (independent of the run)."""
    type: Literal[EventType.SUBAGENT_ERROR] = EventType.SUBAGENT_ERROR  # pyright: ignore[reportIncompatibleVariableOverride]
    subagent_id: str
    message: str
    code: Optional[str] = None
```

- [ ] **Step 6: Add the classes to the `Event` union**

In the `Event = Annotated[Union[...], Field(discriminator="type")]` block, add the three classes to the `Union[...]` list (after `ReasoningEncryptedValueEvent`):

```python
        SubagentStartedEvent,
        SubagentFinishedEvent,
        SubagentErrorEvent,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd sdks/python && python -m unittest tests.test_subagent -v`
Expected: PASS

- [ ] **Step 8: Run the full Python event/type suites**

Run: `cd sdks/python && python -m unittest tests.test_events tests.test_types tests.test_encoder -v`
Expected: PASS (union/enum additions did not break existing discriminated-union or encoder tests).

- [ ] **Step 9: Commit**

```bash
git add sdks/python/ag_ui/core/events.py sdks/python/tests/test_subagent.py
git commit -m "feat(python): add subagent_id to events and SUBAGENT_* lifecycle events"
```

---

## Task 10: Cross-cutting verification

**Files:** none (verification only).

- [ ] **Step 1: TypeScript — full affected build, types, tests, lint**

Run from `sdks/typescript`:
```bash
pnpm --filter @ag-ui/core --filter @ag-ui/client build
pnpm --filter @ag-ui/core --filter @ag-ui/client check-types
pnpm --filter @ag-ui/core --filter @ag-ui/client test
pnpm --filter @ag-ui/core --filter @ag-ui/client lint
```
Expected: all PASS. (If the repo prefers Nx, the equivalent is `nx run-many -t build,test,lint,check-types -p @ag-ui/core,@ag-ui/client`.)

- [ ] **Step 2: Python — full core test suite**

Run: `cd sdks/python && python -m unittest discover tests`
Expected: PASS.

- [ ] **Step 3: Manual backwards-compat sanity check**

Confirm by inspection against the spec's backwards-compatibility section:
- No run-lifecycle event schema (`RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`) was modified.
- Every new field is optional in both TS (`z.string().optional()`) and Python (`Optional[str] = None`), except the intentionally-required lifecycle payload fields (`SUBAGENT_STARTED.name`, `SUBAGENT_ERROR.message`, and each lifecycle event's `subagentId`).
- No existing test file was modified to accommodate new behavior (only additions).

- [ ] **Step 4: Commit any formatting fixups**

```bash
cd sdks/typescript && pnpm format
git add -A
git commit -m "chore: format subagent support changes" || echo "nothing to format"
```

---

## Self-Review Notes

- **Spec coverage:** §1a event attribution → Tasks 2, 5 (chunks); §1b message attribution → Tasks 1, 8; §1c apply-time transfer + no-overwrite → Task 4; §1d verification/interleaving → covered by no-op (documented) + Task 7's no-lifecycle passthrough test; §Phase 2 lifecycle events → Tasks 3, 9; §Phase 2 verification → Task 7; §consumer surface hooks → Task 6; §SDK scope Python → Tasks 8, 9; §backwards compat → Task 10 Step 3; §testing → each task's tests + Task 10.
- **Type consistency:** field name `subagentId` (TS) / `subagent_id` (Python, camelCase wire) used uniformly; event names `SubagentStartedEvent`/`SubagentFinishedEvent`/`SubagentErrorEvent` and factory names `createSubagent*Event` consistent across Tasks 3 and 6.
- **Known harness caveat:** the RxJS apply-test helper in Task 4 Step 1 is a sketch; the executing engineer must align it with a sibling apply test's exact subscribe/collect pattern (called out inline). Assertions are the binding contract.
