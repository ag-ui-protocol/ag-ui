/**
 * Data that has to survive a round trip through the client.
 *
 * Some providers attach opaque data to a reasoning block, a text block or a
 * tool call and require it back on the next request: Anthropic signs its
 * thinking blocks, Gemini signs its function calls, OpenAI's Responses API
 * ties reasoning and messages to stored items. An AG-UI client keeps the
 * conversation, so that data has to travel with it. AG-UI's `encryptedValue`
 * (set by REASONING_ENCRYPTED_VALUE on messages and tool calls) is the slot
 * for exactly this. The same slot marks a tool call that is waiting for
 * approval, with the ids its resume needs.
 *
 * The value is a small JSON envelope so this package can tell its own values
 * apart from another producer's opaque string, which it leaves alone.
 */

/** AI SDK provider metadata: provider name -> provider-specific JSON. */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

/**
 * Marks a tool call the AI SDK paused for approval (`needsApproval`), with the
 * ids a resume needs: the SDK's approval id and, when approvals are signed
 * (`experimental_toolApprovalSecret`), its signature.
 */
export interface ApprovalMarker {
  approvalId: string;
  signature?: string;
}

/** What this package keeps in an AG-UI `encryptedValue`. */
export interface Envelope {
  providerMetadata?: ProviderMetadata;
  approval?: ApprovalMarker;
}

const METADATA_KEY = "aiSdkProviderMetadata";
const APPROVAL_KEY = "aiSdkApproval";

/** Merges provider metadata seen across the parts of one block. */
export function mergeProviderMetadata(
  target: ProviderMetadata | undefined,
  next: unknown,
): ProviderMetadata | undefined {
  if (!isRecord(next)) return target;
  const merged: ProviderMetadata = { ...(target ?? {}) };
  for (const [provider, value] of Object.entries(next)) {
    if (!isRecord(value)) continue;
    merged[provider] = { ...(merged[provider] ?? {}), ...value };
  }
  return Object.keys(merged).length > 0 ? merged : target;
}

/** Serialises an envelope into an AG-UI `encryptedValue`; undefined when empty. */
export function encodeEnvelope({ providerMetadata, approval }: Envelope): string | undefined {
  const value: Record<string, unknown> = {};
  if (providerMetadata && Object.keys(providerMetadata).length > 0) value[METADATA_KEY] = providerMetadata;
  if (approval) value[APPROVAL_KEY] = approval;
  return Object.keys(value).length > 0 ? JSON.stringify(value) : undefined;
}

/**
 * Reads an envelope back from an AG-UI `encryptedValue`. A value another
 * producer wrote (anything that is not this package's JSON) reads as empty.
 */
export function decodeEnvelope(encryptedValue: string | undefined): Envelope {
  if (!encryptedValue || encryptedValue[0] !== "{") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptedValue);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const envelope: Envelope = {};

  const metadata = parsed[METADATA_KEY];
  if (isRecord(metadata)) {
    const providerMetadata: ProviderMetadata = {};
    for (const [provider, value] of Object.entries(metadata)) {
      if (isRecord(value)) providerMetadata[provider] = value;
    }
    if (Object.keys(providerMetadata).length > 0) envelope.providerMetadata = providerMetadata;
  }

  const approval = parsed[APPROVAL_KEY];
  if (isRecord(approval) && typeof approval.approvalId === "string" && approval.approvalId) {
    envelope.approval = {
      approvalId: approval.approvalId,
      ...(typeof approval.signature === "string" && { signature: approval.signature }),
    };
  }
  return envelope;
}

/** Serialises provider metadata into an AG-UI `encryptedValue`. */
export function encodeProviderMetadata(metadata: ProviderMetadata | undefined): string | undefined {
  return encodeEnvelope({ providerMetadata: metadata });
}

/** Reads provider metadata back from an AG-UI `encryptedValue`, as AI SDK `providerOptions`. */
export function decodeProviderMetadata(encryptedValue: string | undefined): ProviderMetadata | undefined {
  return decodeEnvelope(encryptedValue).providerMetadata;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares two JSON values structurally (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((value, i) => jsonEqual(value, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const otherKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === otherKeys.length && keys.every((key) => jsonEqual(a[key], b[key]));
  }
  return false;
}
