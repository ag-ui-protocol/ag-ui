/**
 * The provider artefacts of one reasoning span: what a provider needs back on a
 * later turn to restore the reasoning it stands for (an Anthropic thinking
 * signature or redacted block, an OpenAI reasoning item id and encrypted
 * content). Mastra carries them on the reasoning chunks' `providerMetadata`,
 * plus `signature` on reasoning-start/-end and the `reasoning-signature` /
 * `redacted-reasoning` chunks its ChunkType declares.
 *
 * The bridge sends them to the client as REASONING_ENCRYPTED_VALUE and reads
 * them back from the reasoning message in later run input. The encoded value is
 * opaque to the client; only this module reads it.
 */
export interface ReasoningArtifact {
  providerMetadata?: Record<string, Record<string, unknown>>;
  signature?: string;
  redactedData?: unknown;
}

const ENVELOPE_TAG = "@ag-ui/mastra/reasoning";
const ENVELOPE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The artefact a reasoning chunk payload carries, or undefined for none. */
export function readReasoningArtifact(
  payload: unknown,
): ReasoningArtifact | undefined {
  if (!isRecord(payload)) return undefined;
  const artifact: ReasoningArtifact = {};
  if (isRecord(payload.providerMetadata)) {
    const providerMetadata: Record<string, Record<string, unknown>> = {};
    for (const [provider, value] of Object.entries(payload.providerMetadata)) {
      if (isRecord(value) && Object.keys(value).length > 0) {
        providerMetadata[provider] = value;
      }
    }
    if (Object.keys(providerMetadata).length > 0) {
      artifact.providerMetadata = providerMetadata;
    }
  }
  if (typeof payload.signature === "string" && payload.signature !== "") {
    artifact.signature = payload.signature;
  }
  return isEmptyReasoningArtifact(artifact) ? undefined : artifact;
}

export function isEmptyReasoningArtifact(artifact: ReasoningArtifact): boolean {
  return (
    artifact.providerMetadata === undefined &&
    artifact.signature === undefined &&
    artifact.redactedData === undefined
  );
}

/**
 * Later values win, per provider key, so the signature an Anthropic stream
 * sends on its last reasoning delta joins what the start chunk carried.
 */
export function mergeReasoningArtifact(
  target: ReasoningArtifact,
  update: ReasoningArtifact,
): ReasoningArtifact {
  const merged: ReasoningArtifact = { ...target };
  if (update.providerMetadata) {
    const providerMetadata = { ...(target.providerMetadata ?? {}) };
    for (const [provider, value] of Object.entries(update.providerMetadata)) {
      providerMetadata[provider] = {
        ...(providerMetadata[provider] ?? {}),
        ...value,
      };
    }
    merged.providerMetadata = providerMetadata;
  }
  if (update.signature !== undefined) merged.signature = update.signature;
  if (update.redactedData !== undefined) {
    merged.redactedData = update.redactedData;
  }
  return merged;
}

export function encodeReasoningArtifact(artifact: ReasoningArtifact): string {
  return JSON.stringify({
    [ENVELOPE_TAG]: ENVELOPE_VERSION,
    ...artifact,
  });
}

/**
 * The artefact this bridge encoded, or undefined for anything else: a value
 * another producer issued is never handed to Mastra.
 */
export function decodeReasoningArtifact(
  value: unknown,
): ReasoningArtifact | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed[ENVELOPE_TAG] !== ENVELOPE_VERSION) {
    return undefined;
  }
  const artifact: ReasoningArtifact = {};
  if (isRecord(parsed.providerMetadata)) {
    artifact.providerMetadata = parsed.providerMetadata as Record<
      string,
      Record<string, unknown>
    >;
  }
  if (typeof parsed.signature === "string") {
    artifact.signature = parsed.signature;
  }
  if (parsed.redactedData !== undefined) {
    artifact.redactedData = parsed.redactedData;
  }
  return isEmptyReasoningArtifact(artifact) ? undefined : artifact;
}

/**
 * The assistant content part that hands a reasoning span back to Mastra.
 * Mastra's input converter keeps `providerOptions` as the part's
 * `providerMetadata`, which is what it sends to the provider as the reasoning
 * part's provider options; `signature` and `redacted-reasoning` data are the
 * AI SDK v4 fields it also reads.
 */
export function reasoningArtifactToMastraPart(
  text: string,
  artifact: ReasoningArtifact,
): Record<string, unknown> {
  const providerOptions = artifact.providerMetadata
    ? { providerOptions: artifact.providerMetadata }
    : {};
  if (artifact.redactedData !== undefined && text === "") {
    return {
      type: "redacted-reasoning",
      data: artifact.redactedData,
      ...providerOptions,
    };
  }
  return {
    type: "reasoning",
    text,
    ...(artifact.signature !== undefined
      ? { signature: artifact.signature }
      : {}),
    ...providerOptions,
  };
}
