import { describe, expect, it } from "vitest";
import {
  aggregateTokenUsage,
  tokenUsageFromAiSdkUsage,
  tokenUsageFromLangChainMetadata,
} from "../token-usage";

describe("tokenUsageFromAiSdkUsage", () => {
  it("maps AI-SDK v5 usage (keys already match TokenUsage)", () => {
    const u = tokenUsageFromAiSdkUsage(
      {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
        cachedInputTokens: 10,
      },
      { provider: "openai", model: "gpt-4o" },
    );
    expect(u).toEqual({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
      cachedInputTokens: 10,
    });
  });

  it("ignores non-finite counts (AI-SDK reports NaN for unknown)", () => {
    const u = tokenUsageFromAiSdkUsage(
      { inputTokens: 12, outputTokens: NaN, totalTokens: undefined },
      {},
    );
    expect(u).toEqual({ inputTokens: 12 });
  });

  it("returns undefined when no finite counts are present", () => {
    expect(tokenUsageFromAiSdkUsage({ inputTokens: NaN }, {})).toBeUndefined();
    expect(tokenUsageFromAiSdkUsage(undefined, {})).toBeUndefined();
  });
});

describe("tokenUsageFromLangChainMetadata", () => {
  it("maps core and detail fields", () => {
    const u = tokenUsageFromLangChainMetadata(
      {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 10 },
        output_token_details: { reasoning: 20 },
      },
      { provider: "anthropic", model: "claude-sonnet-4" },
    );
    expect(u).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
      cachedInputTokens: 10,
    });
  });

  it("returns undefined for missing/empty metadata", () => {
    expect(tokenUsageFromLangChainMetadata(undefined, {})).toBeUndefined();
    expect(tokenUsageFromLangChainMetadata(null, {})).toBeUndefined();
  });

  it("omits absent fields entirely", () => {
    expect(tokenUsageFromLangChainMetadata({ input_tokens: 5 }, {})).toEqual({ inputTokens: 5 });
  });
});

describe("aggregateTokenUsage", () => {
  it("sums entries for the same provider/model", () => {
    const agg = aggregateTokenUsage([
      { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ inputTokens: 110, outputTokens: 25, totalTokens: 135 });
  });

  it("keeps distinct models separate and preserves first-seen order", () => {
    const agg = aggregateTokenUsage([
      { provider: "openai", model: "gpt-4o", inputTokens: 1 },
      { provider: "openai", model: "gpt-4o-mini", inputTokens: 2 },
      { provider: "openai", model: "gpt-4o", inputTokens: 3 },
    ]);
    expect(agg.map((u) => u.model)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(agg[0].inputTokens).toBe(4);
    expect(agg[1].inputTokens).toBe(2);
  });

  it("returns [] for empty input", () => {
    expect(aggregateTokenUsage([])).toEqual([]);
  });

  it("leaves a count undefined when no group member reported it", () => {
    const agg = aggregateTokenUsage([
      { provider: "p", model: "m", inputTokens: 1 },
      { provider: "p", model: "m", inputTokens: 2 },
    ]);
    expect(agg[0].inputTokens).toBe(3);
    expect(agg[0].outputTokens).toBeUndefined();
  });
});
