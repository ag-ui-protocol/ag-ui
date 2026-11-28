package com.agui.community.core.event;

/**
 * Token counts for one provider and model, using the AG-UI accounting model.
 *
 * <p>Every field is optional. A {@code null} count is unknown, while zero is a
 * reported value. Counts must be non-negative JSON safe integers, at most
 * {@code 9_007_199_254_740_991}. This record does not collect, normalize or sum
 * provider usage.
 *
 * <p>Input and output counts are totals. Reasoning tokens are part of output;
 * cache reads and writes are disjoint parts of input, never additions to it.
 *
 * @param provider              the provider label, or {@code null}
 * @param model                 the model label, or {@code null}
 * @param inputTokens           all input tokens, including cache reads and writes
 * @param outputTokens          all generated tokens, including reasoning
 * @param totalTokens           input plus output tokens
 * @param reasoningTokens       the reasoning portion of output tokens
 * @param cachedInputTokens     input tokens read from a provider cache
 * @param cacheWriteInputTokens input tokens written to a provider cache
 * @see <a href="https://docs.ag-ui.com/spec/1.0/schema#tokenusage">TokenUsage schema</a>
 */
public record TokenUsage(String provider, String model, Long inputTokens, Long outputTokens,
                         Long totalTokens, Long reasoningTokens, Long cachedInputTokens,
                         Long cacheWriteInputTokens) {

    private static final long MAX_TOKEN_COUNT = 9_007_199_254_740_991L;

    public TokenUsage {
        validateCount("inputTokens", inputTokens);
        validateCount("outputTokens", outputTokens);
        validateCount("totalTokens", totalTokens);
        validateCount("reasoningTokens", reasoningTokens);
        validateCount("cachedInputTokens", cachedInputTokens);
        validateCount("cacheWriteInputTokens", cacheWriteInputTokens);
    }

    private static void validateCount(String field, Long count) {
        if (count != null && (count < 0 || count > MAX_TOKEN_COUNT)) {
            throw new IllegalArgumentException(field + " must be between 0 and " + MAX_TOKEN_COUNT);
        }
    }
}
