using System;
using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

internal struct TextMessageTracker
{
    // The id that went out on TEXT_MESSAGE_START, and the provider id it was opened for.
    // They differ once a provider id is resumed after its message was closed.
    private string? _currentMessageId;
    private string? _currentProviderMessageId;

    // How many text messages each provider id has opened in this stream. Providers stamp one
    // id on a whole response, so text that resumes after a tool call, reasoning, approval or
    // interrupt closed the message must start a new one rather than reopen the closed id.
    // Reference-typed, so this struct must stay a single local and never be copied.
    private Dictionary<string, int>? _openCountsByProviderId;

    public bool IsActive => _currentMessageId is not null;

    public bool IsMessageId(string? messageId) =>
        _currentMessageId is not null
        && string.Equals(_currentProviderMessageId, messageId, StringComparison.Ordinal);

    // The id of the most recent text message opened for a provider id, so a tool call hangs off
    // the text segment it followed (m1, then m1-2, ...). Falls back to the provider id when no
    // text has been opened for it in this stream.
    public string? ParentIdFor(string? providerMessageId)
    {
        if (providerMessageId is null
            || _openCountsByProviderId is null
            || !_openCountsByProviderId.TryGetValue(providerMessageId, out var opened))
        {
            return providerMessageId;
        }

        return DerivedId(providerMessageId, opened);
    }

    public BaseEvent? Close(JsonElement? raw = null)
    {
        if (_currentMessageId is null)
        {
            return null;
        }

        var evt = TextMessageEndEvent.Create(_currentMessageId, raw);
        _currentMessageId = null;
        _currentProviderMessageId = null;
        return evt;
    }

    public BaseEvent Open(string messageId, string role, string? name, JsonElement? raw)
    {
        _openCountsByProviderId ??= new Dictionary<string, int>(StringComparer.Ordinal);
        _openCountsByProviderId.TryGetValue(messageId, out var opened);
        _openCountsByProviderId[messageId] = ++opened;

        _currentProviderMessageId = messageId;
        _currentMessageId = DerivedId(messageId, opened);
        return TextMessageStartEvent.Create(_currentMessageId, role, name, raw);
    }

    private static string DerivedId(string providerMessageId, int opened) =>
        opened == 1 ? providerMessageId : $"{providerMessageId}-{opened}";

    public BaseEvent EmitDelta(string text, JsonElement? raw)
    {
        return TextMessageContentEvent.Create(_currentMessageId!, text, raw);
    }
}
