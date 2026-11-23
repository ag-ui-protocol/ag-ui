import {
  type AgentToRendererMessage,
  AgentToRendererMessageSchema,
} from "@a2ui/web_core/v1_0";

import { A2UI_MIME_TYPE } from "./protocol";

export type A2uiOperationKind =
  | "createSurface"
  | "updateComponents"
  | "updateDataModel"
  | "deleteSurface"
  | "callRendererFunction"
  | "agentFunctionResponse";

export class A2uiMcpError extends Error {
  override readonly name = "A2uiMcpError";
}

const encoder = new TextEncoder();

export function isA2uiMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  const baseType = mimeType.split(";")[0];
  return baseType.trim().toLowerCase() === A2UI_MIME_TYPE;
}

export function operationKind(
  message: AgentToRendererMessage,
): A2uiOperationKind {
  const keys = Object.keys(message).filter((key) => key !== "version");
  return keys[0] as A2uiOperationKind;
}

export function assertPayloadSize(
  texts: readonly string[],
  maxPayloadBytes: number,
): void {
  let bytes = 0;
  for (const text of texts) {
    bytes += encoder.encode(text).byteLength;
  }

  if (bytes > maxPayloadBytes) {
    throw new A2uiMcpError(
      `A2UI payload exceeds the limit of ${maxPayloadBytes} bytes.`,
    );
  }
}

export function parseA2uiMessages(
  text: string,
  allowedKinds: readonly A2uiOperationKind[],
): AgentToRendererMessage[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new A2uiMcpError("A2UI payload is not valid JSON.");
  }

  const items: unknown[] = Array.isArray(json) ? json : [json];

  return items.map((item, index) => {
    const parsed = AgentToRendererMessageSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new A2uiMcpError(
        `Invalid A2UI 1.0 message at index ${index}: ${issue?.message}`,
      );
    }

    const message = item as AgentToRendererMessage;
    const kind = operationKind(message);
    if (!allowedKinds.includes(kind)) {
      throw new A2uiMcpError(
        `Unsupported A2UI operation '${kind}' at index ${index}.`,
      );
    }
    return message;
  });
}
