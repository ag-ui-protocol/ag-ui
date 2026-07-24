import { TokenUsage } from "./events";

/**
 * Map a LangChain-family `usage_metadata` object into an AG-UI {@link TokenUsage}.
 *
 * LangChain and LangGraph both attach usage as `{ input_tokens, output_tokens,
 * total_tokens, input_token_details: { cache_read }, output_token_details:
 * { reasoning } }`. This maps only those numeric counts plus optional
 * provider/model labels — never prompt/completion content. Returns `undefined`
 * when no usage metadata is present, so callers can omit usage rather than
 * report zeros.
 */
export function tokenUsageFromLangChainMetadata(
  usageMetadata: any,
  { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined {
  if (!usageMetadata) return undefined;

  const inputDetails = usageMetadata.input_token_details ?? {};
  const outputDetails = usageMetadata.output_token_details ?? {};

  const entry: TokenUsage = {};
  if (provider != null) entry.provider = provider;
  if (model != null) entry.model = model;
  if (usageMetadata.input_tokens != null) entry.inputTokens = usageMetadata.input_tokens;
  if (usageMetadata.output_tokens != null) entry.outputTokens = usageMetadata.output_tokens;
  if (usageMetadata.total_tokens != null) entry.totalTokens = usageMetadata.total_tokens;
  if (outputDetails.reasoning != null) entry.reasoningTokens = outputDetails.reasoning;
  if (inputDetails.cache_read != null) entry.cachedInputTokens = inputDetails.cache_read;

  return entry;
}

/**
 * Map an AI-SDK (v5) `LanguageModelUsage` object into an AG-UI {@link TokenUsage}.
 *
 * AI-SDK's keys already match: `inputTokens`, `outputTokens`, `totalTokens`,
 * `reasoningTokens`, `cachedInputTokens`. AI-SDK reports `NaN`/`undefined` for
 * counts a provider didn't return, so only finite numbers are copied. Returns
 * `undefined` when no finite count is present (so callers omit empty usage).
 */
export function tokenUsageFromAiSdkUsage(
  usage: any,
  { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined {
  if (!usage) return undefined;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const counts: Partial<Record<keyof TokenUsage, number | undefined>> = {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    totalTokens: num(usage.totalTokens),
    reasoningTokens: num(usage.reasoningTokens),
    cachedInputTokens: num(usage.cachedInputTokens),
  };
  if (!Object.values(counts).some((v) => v !== undefined)) return undefined;

  const entry: TokenUsage = {};
  if (provider != null) entry.provider = provider;
  if (model != null) entry.model = model;
  for (const [key, value] of Object.entries(counts)) {
    if (value !== undefined) (entry as any)[key] = value;
  }
  return entry;
}

const COUNT_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;

/**
 * Sum per-call {@link TokenUsage} entries into one entry per `(provider, model)`
 * pair. Order follows first appearance. A count field stays `undefined` when no
 * member of the group reported it, so "not reported" stays distinct from zero.
 *
 * Protocol-agnostic: works on any producer's `TokenUsage[]`, so integrations
 * share it rather than reimplementing aggregation.
 */
export function aggregateTokenUsage(entries: TokenUsage[]): TokenUsage[] {
  const grouped = new Map<string, TokenUsage>();

  for (const entry of entries) {
    const key = `${entry.provider ?? ""} ${entry.model ?? ""}`;
    let target = grouped.get(key);
    if (!target) {
      target = { provider: entry.provider, model: entry.model };
      grouped.set(key, target);
    }
    for (const field of COUNT_FIELDS) {
      const value = entry[field];
      if (value == null) continue;
      target[field] = (target[field] ?? 0) + value;
    }
  }

  return [...grouped.values()];
}
