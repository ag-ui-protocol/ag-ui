using System.Collections.Generic;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

// Accumulates the UsageContent reported across a run's ChatResponseUpdate stream
// into one TokenUsage entry per (provider, model), preserving first-appearance
// order. Mirrors `aggregateTokenUsage` in sdks/typescript/packages/core/src/token-usage.ts.
//
// A count stays null unless at least one update reported it, so "the provider never
// reported this" stays distinct from "the provider reported zero".
internal sealed class TokenUsageTracker
{
    // MEAI has no first-class cache-write count. A provider adapter that reports one
    // does so in AdditionalCounts, and this is the key AGUI.Client writes it under, so
    // a count survives a .NET-to-.NET hop through the abstraction unchanged.
    internal const string CacheWriteInputTokensCountKey = "CacheWriteInputTokens";

    private readonly Dictionary<(string? Provider, string? Model), TokenUsage> _byProviderModel = [];
    private readonly List<TokenUsage> _inFirstAppearanceOrder = [];

    public void Add(UsageDetails details, string? provider, string? model)
    {
        // Providers that don't echo a label leave these empty rather than null.
        // Normalise to null so the field is omitted rather than emitted blank.
        provider = string.IsNullOrWhiteSpace(provider) ? null : provider;
        model = string.IsNullOrWhiteSpace(model) ? null : model;

        var key = (provider, model);
        if (!_byProviderModel.TryGetValue(key, out var entry))
        {
            entry = new TokenUsage { Provider = provider, Model = model };
            _byProviderModel[key] = entry;
            _inFirstAppearanceOrder.Add(entry);
        }

        entry.InputTokens = Sum(entry.InputTokens, details.InputTokenCount);
        entry.OutputTokens = Sum(entry.OutputTokens, details.OutputTokenCount);
        entry.TotalTokens = Sum(entry.TotalTokens, details.TotalTokenCount);
        entry.ReasoningTokens = Sum(entry.ReasoningTokens, details.ReasoningTokenCount);
        entry.CachedInputTokens = Sum(entry.CachedInputTokens, details.CachedInputTokenCount);
        entry.CacheWriteInputTokens = Sum(entry.CacheWriteInputTokens, CacheWriteInputTokenCount(details));
    }

    // Absent key means unreported, and stays null like every other unreported count.
    private static long? CacheWriteInputTokenCount(UsageDetails details) =>
        details.AdditionalCounts is { } counts
            && counts.TryGetValue(CacheWriteInputTokensCountKey, out var count)
            ? count
            : null;

    // Null when nothing was reported, so the terminal event omits `usage` on the wire
    // rather than carrying an empty array.
    public IList<TokenUsage>? Build() =>
        _inFirstAppearanceOrder.Count == 0 ? null : _inFirstAppearanceOrder;

    // Adding to null yields the reported value rather than leaving null, but an
    // unreported count never promotes an accumulated null to zero.
    private static long? Sum(long? accumulated, long? reported) =>
        reported is null ? accumulated : (accumulated ?? 0) + reported.Value;
}
