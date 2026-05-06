// Fixture: input for the 0.1.0-schemas-to-subpath codemod
// Covers: pure schema import, pure type import, mixed import,
//         existing @ag-ui/core/schemas import that should be merged into.

// ── 1. Schemas only ──────────────────────────────────────────────────────────
import { UserMessageSchema, EventSchemas } from "@ag-ui/core";

// ── 2. Pure type import (should be untouched) ─────────────────────────────────
import type { Message, Tool, EventType } from "@ag-ui/core";

// ── 3. Mixed types and schemas ────────────────────────────────────────────────
import { Message as CoreMessage, AgentCapabilitiesSchema, RunAgentInputSchema } from "@ag-ui/core";

// ── 4. Already-present @ag-ui/core/schemas import (new specifiers should merge) ─
import { BaseEventSchema } from "@ag-ui/core/schemas";

// ── 5. Non-schema import that must stay on @ag-ui/core ───────────────────────
import { EventType as ET } from "@ag-ui/core";

// ── Unrelated import — must not be touched ────────────────────────────────────
import { z } from "zod";

export function validate(raw: unknown) {
  return EventSchemas.safeParse(raw);
}

export function parseUser(raw: unknown) {
  return UserMessageSchema.safeParse(raw);
}

export function useMessage(msg: Message) {
  return msg;
}

export { CoreMessage };
