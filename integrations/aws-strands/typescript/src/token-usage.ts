/**
 * Strands token usage, mapped onto the AG-UI `TokenUsage` shape.
 *
 * Strands reports usage per model invocation on `modelMetadataEvent`, not only
 * on the terminal `AgentResult`. That per-call channel is the one this adapter
 * reads: `AgentResult.metrics.accumulatedUsage` is pre-summed AND seeded with
 * zeros, so it cannot tell "the provider reported nothing" apart from "the
 * provider reported zero", and the two have to stay distinguishable for the
 * terminal event to omit `usage` rather than claim a measured zero.
 *
 * The mapper stays local to this integration rather than joining the LangChain
 * and AI-SDK mappers in `@ag-ui/core`: the Python bridge consumes the PUBLISHED
 * ag-ui-protocol, so a new core mapper would not exist for it until the next
 * SDK release, and the two bridges have to ship together. Only the aggregation
 * helper is shared, because that one is already published.
 */

import type { TokenUsage } from "@ag-ui/core";

/**
 * The ceiling every AG-UI binding can carry a count through.
 *
 * `TokenUsageSchema` constrains counts to non-negative integers but sets no
 * upper bound, so it is NOT the backstop here: a count above this passes
 * validation and then throws inside the protobuf transport's int64 decoder
 * ("Value is larger than Number.MAX_SAFE_INTEGER"), which fails an otherwise
 * successful run at its final event on the binary wire while the SSE wire
 * carries the same run fine. Bounding it at the source is what keeps the two
 * transports reporting the same thing.
 */
const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Accept a count only if it is a real, finite, non-negative whole number the
 * wire can carry; otherwise drop it.
 *
 * Dropped, never clamped and never zeroed: a clamped count would report a
 * number no provider gave, and a zeroed one would claim a measurement that was
 * never made. The rest of the entry survives, so one bad field does not cost
 * the caller the counts that were fine.
 *
 * `@ag-ui/core`'s shared `num()` guard checks finiteness only and leaves the
 * integer and non-negative bounds to schema validation, which is why this is
 * its own guard rather than a reuse: the full bound has to be applied here for
 * the Python bridge's guard to behave identically.
 *
 * `typeof` excludes booleans on its own. Python's mirror has to exclude `bool`
 * explicitly, since there it subclasses `int`.
 */
function _count(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  // Rejects NaN and both infinities as well as fractions.
  if (!Number.isInteger(value)) return undefined;
  if (value < 0 || value > MAX_TOKEN_COUNT) return undefined;
  return value;
}

/** Read a key off a value of unknown shape, yielding `undefined` for non-objects. */
function _read(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Provider label per Strands model class, keyed on the class name.
 *
 * An explicit table rather than a name-derived label (`AnthropicModel` ->
 * `anthropic`) because the derivation is exactly what would drift between the
 * two bridges: the SDKs do not name the same provider's class identically, so
 * the Python bridge's `GeminiModel` and this SDK's `GoogleModel` have to be
 * spelled onto one canonical label by hand. Changing a value here is a
 * wire-contract change that has to land on both bridges together.
 *
 * A class this table does not name omits the provider label rather than
 * guessing one, which also covers an integrator's own `Model` subclass: a
 * subclass of `BedrockModel` reports its own class name, and inventing
 * "bedrock" for it would attribute the spend to a provider nobody named.
 */
const STRANDS_PROVIDER_LABELS: Record<string, string> = {
  AnthropicModel: "anthropic",
  BedrockModel: "bedrock",
  GoogleModel: "google",
  OpenAIModel: "openai",
  VercelModel: "vercel",
};

/** The provider/model labels an entry carries, either of which may be absent. */
export interface StrandsModelIdentity {
  provider?: string;
  model?: string;
}

/**
 * Label a Strands model, reading nothing but the class name and the model id.
 *
 * Every read is defensive and a failure omits the label rather than failing the
 * run: `getConfig()` is integrator-supplied code that can throw, may hand back
 * something that is not a mapping, and may not carry `modelId` at all. Usage is
 * a report about a run, so it must never be the thing that ends one.
 */
export function strandsModelIdentity(model: unknown): StrandsModelIdentity {
  if (!model || typeof model !== "object") return {};

  const identity: StrandsModelIdentity = {};

  const className = (model as { constructor?: { name?: unknown } }).constructor
    ?.name;
  if (typeof className === "string") {
    const provider = STRANDS_PROVIDER_LABELS[className];
    if (provider !== undefined) identity.provider = provider;
  }

  let config: unknown;
  try {
    const getConfig = (model as { getConfig?: unknown }).getConfig;
    if (typeof getConfig === "function") {
      config = (getConfig as () => unknown).call(model);
    }
  } catch {
    // A model that cannot report its config is a model with no label, not a
    // failed run.
  }
  const modelId = _read(config, "modelId");
  if (typeof modelId === "string" && modelId.length > 0) {
    identity.model = modelId;
  }

  return identity;
}

/**
 * Providers whose Strands `Usage` reports the cache counts BESIDE `inputTokens`
 * rather than within it. Anthropic's API counts `input_tokens` net of both
 * cache reads and cache writes and Strands' `AnthropicModel` passes that
 * through; Bedrock's Converse API counts the same way and `BedrockModel`
 * forwards its usage unchanged. Every other provider Strands ships — OpenAI,
 * Gemini, the Vercel bridge — already reports an inclusive input count.
 *
 * AG-UI's accounting is the inclusive one: `cachedInputTokens` and
 * `cacheWriteInputTokens` are parts of `inputTokens`, never additions to it.
 * So for these two the cache counts are added into `inputTokens`, and
 * `totalTokens` recomputed from the adjusted input, before the entry leaves.
 * Keyed on the canonical provider label, the one thing both bridges spell
 * identically; an unlabelled entry says nothing about which way it counts and
 * is left alone.
 */
const CACHE_BESIDE_INPUT_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "bedrock",
]);

/**
 * Map one Strands `Usage` onto an AG-UI `TokenUsage`, or `undefined` when no
 * count survived the guard.
 *
 * Both cache counts map: `cacheReadInputTokens` to `cachedInputTokens` and
 * `cacheWriteInputTokens` to its namesake. For a provider in
 * {@link CACHE_BESIDE_INPUT_PROVIDERS} they are also folded into `inputTokens`,
 * which is what AG-UI's inclusive accounting requires and what that provider's
 * own count leaves out. Strands reports no reasoning-token count, so
 * `reasoningTokens` is never set.
 *
 * Numeric counts and the two labels only. No prompts, completions, message
 * content, thread/run/user ids, latency or traces: this shape feeds anonymous
 * telemetry, and a labels-only entry is not usage, so an entry is returned only
 * when at least one count survives.
 */
export function tokenUsageFromStrandsUsage(
  usage: unknown,
  identity: StrandsModelIdentity = {},
): TokenUsage | undefined {
  let inputTokens = _count(_read(usage, "inputTokens"));
  const outputTokens = _count(_read(usage, "outputTokens"));
  let totalTokens = _count(_read(usage, "totalTokens"));
  const cachedInputTokens = _count(_read(usage, "cacheReadInputTokens"));
  const cacheWriteInputTokens = _count(_read(usage, "cacheWriteInputTokens"));

  if (
    inputTokens !== undefined &&
    identity.provider !== undefined &&
    CACHE_BESIDE_INPUT_PROVIDERS.has(identity.provider)
  ) {
    const cached = (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
    if (cached > 0) {
      // Re-guarded: the sum can leave the wire range even though each part was
      // inside it, and then it is dropped like any other uncarriable count.
      inputTokens = _count(inputTokens + cached);
      // The provider's total summed the counts IT reported. Recompute it from
      // the adjusted input, or drop it when either half is missing, rather
      // than carry a total that no longer equals input plus output.
      totalTokens =
        inputTokens !== undefined && outputTokens !== undefined
          ? _count(inputTokens + outputTokens)
          : undefined;
    }
  }

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheWriteInputTokens === undefined
  ) {
    return undefined;
  }

  const entry: TokenUsage = {};
  if (identity.provider !== undefined) entry.provider = identity.provider;
  if (identity.model !== undefined) entry.model = identity.model;
  if (inputTokens !== undefined) entry.inputTokens = inputTokens;
  if (outputTokens !== undefined) entry.outputTokens = outputTokens;
  if (totalTokens !== undefined) entry.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined) {
    entry.cachedInputTokens = cachedInputTokens;
  }
  if (cacheWriteInputTokens !== undefined) {
    entry.cacheWriteInputTokens = cacheWriteInputTokens;
  }
  return entry;
}
