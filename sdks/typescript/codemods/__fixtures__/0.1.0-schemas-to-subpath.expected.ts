// ── 2. Pure type import (should be untouched) ─────────────────────────────────
import type { Message, Tool, EventType } from "@ag-ui/core";

// ── 3. Mixed types and schemas ────────────────────────────────────────────────
import { Message as CoreMessage } from "@ag-ui/core";

// ── 4. Already-present @ag-ui/core/schemas import (new specifiers should merge) ─
import {
  BaseEventSchema,
  UserMessageSchema,
  EventSchemas,
  AgentCapabilitiesSchema,
  RunAgentInputSchema,
} from "@ag-ui/core/schemas";

// ── 5. Non-schema import that must stay on @ag-ui/core ───────────────────────
import { EventType as ET } from "@ag-ui/core";

// ── 8. Namespace import — must be warned about and left untouched ─────────────
import * as core from "@ag-ui/core";

// ── Unrelated import — must not be touched ────────────────────────────────────
import { z } from "zod";

import type { ToolSchema, ContextSchema, StateSchema } from "@ag-ui/core/schemas";

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
