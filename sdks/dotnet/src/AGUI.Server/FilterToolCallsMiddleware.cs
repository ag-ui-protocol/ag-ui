using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Server;

/// <summary>
/// An <see cref="AGUIMiddleware"/> that keeps selected tool calls off the wire while the agent
/// still runs them. The .NET counterpart of the TypeScript SDK's <c>FilterToolCallsMiddleware</c>.
/// </summary>
/// <remarks>
/// <para>
/// Create it with <see cref="Allow"/> (only the named tools are visible) or <see cref="Disallow"/>
/// (the named tools are hidden). For a hidden call the middleware drops
/// <see cref="ToolCallStartEvent"/>, <see cref="ToolCallArgsEvent"/>, <see cref="ToolCallEndEvent"/>,
/// <see cref="ToolCallResultEvent"/> and <see cref="ToolCallChunkEvent"/>. It also keeps the call
/// from reaching the client by any other route:
/// </para>
/// <list type="bullet">
/// <item><description>A <see cref="MessagesSnapshotEvent"/> loses the hidden tool calls on its
/// assistant messages and the matching tool messages. An assistant message left with neither
/// content nor tool calls is removed.</description></item>
/// <item><description>An event whose <see cref="BaseEvent.RawEvent"/> mentions a hidden call (for
/// example a text event built from an update that also carried the hidden call) is sent without
/// its <c>rawEvent</c>.</description></item>
/// <item><description>A <see cref="RawEvent"/> whose payload mentions a hidden call is
/// dropped.</description></item>
/// </list>
/// <para>
/// Events produced by <see cref="AGUIStreamOptions.MapCall"/> or <see cref="AGUIStreamOptions.MapResult"/>
/// carry no tool call ID and pass through, so a hidden tool can still be projected into a
/// sanitized state or activity event. Interrupts are not altered: hiding a tool that needs approval
/// hides its call events, but the run's interrupt outcome still describes the call. Which tools
/// to hide is the application's decision; hiding a client tool keeps the client from running it.
/// </para>
/// <para>
/// Run it as the outermost middleware unless another middleware is trusted with the hidden data.
/// </para>
/// </remarks>
public sealed class FilterToolCallsMiddleware : AGUIMiddleware
{
    private readonly HashSet<string> _toolNames;
    private readonly bool _isAllowList;
    private readonly Func<string, bool> _isHiddenToolName;

    private FilterToolCallsMiddleware(IEnumerable<string> toolNames, bool isAllowList)
    {
        _toolNames = new HashSet<string>(toolNames, StringComparer.Ordinal);
        _isAllowList = isAllowList;
        _isHiddenToolName = IsHiddenToolName;
    }

    /// <summary>
    /// Creates a filter under which only the named tools' calls are visible to the client.
    /// </summary>
    /// <param name="toolNames">The tools whose calls the client may see.</param>
    /// <returns>The middleware.</returns>
    public static FilterToolCallsMiddleware Allow(IEnumerable<string> toolNames)
    {
        ArgumentNullThrowHelper.ThrowIfNull(toolNames);
        return new FilterToolCallsMiddleware(toolNames, isAllowList: true);
    }

    /// <summary>
    /// Creates a filter that hides the named tools' calls from the client.
    /// </summary>
    /// <param name="toolNames">The tools whose calls the client must not see.</param>
    /// <returns>The middleware.</returns>
    public static FilterToolCallsMiddleware Disallow(IEnumerable<string> toolNames)
    {
        ArgumentNullThrowHelper.ThrowIfNull(toolNames);
        return new FilterToolCallsMiddleware(toolNames, isAllowList: false);
    }

    /// <inheritdoc />
    public override IAsyncEnumerable<BaseEvent> RunAsync(
        RunAgentInput input,
        AGUIRunDelegate next,
        CancellationToken cancellationToken)
    {
        ArgumentNullThrowHelper.ThrowIfNull(input);
        ArgumentNullThrowHelper.ThrowIfNull(next);
        return FilterAsync(input, next(input, cancellationToken), cancellationToken);
    }

    private bool IsHiddenToolName(string toolName) =>
        _isAllowList ? !_toolNames.Contains(toolName) : _toolNames.Contains(toolName);

    private async IAsyncEnumerable<BaseEvent> FilterAsync(
        RunAgentInput input,
        IAsyncEnumerable<BaseEvent> events,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        // Hidden calls already in the input history. With server-side history, a continuation can
        // replay their results, so they stay hidden for the whole run.
        var hiddenHistoryIds = new HashSet<string>(StringComparer.Ordinal);
        RegisterHiddenCalls(input.Messages, hiddenHistoryIds);

        // Per enumeration, so concurrent runs through the same instance never share it.
        var hiddenToolCallIds = new HashSet<string>(hiddenHistoryIds, StringComparer.Ordinal);

        // Which chunk stream each TOOL_CALL_CHUNK continues, resolved as the client resolves it.
        var chunkLanes = new ToolCallChunkLanes();

        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (evt is RunStartedEvent)
            {
                // A new run invalidates IDs left over from one that ended early, and keeps a
                // reused call ID from being shadowed. Reset before reading this event's raw data.
                hiddenToolCallIds.Clear();
                hiddenToolCallIds.UnionWith(hiddenHistoryIds);
            }

            // Read the raw data first, so a call it reveals is hidden on this very event too.
            var rawMentionsHiddenCall = evt.RawEvent is { } rawEvent
                && HiddenToolCallReferenceScanner.References(rawEvent, _isHiddenToolName, !_isAllowList, hiddenToolCallIds);

            var knownHiddenCalls = hiddenToolCallIds.Count;

            BaseEvent? output = evt;
            switch (evt)
            {
                case RunStartedEvent started:
                    output = FilterRunStarted(started, hiddenToolCallIds);
                    break;

                case ToolCallStartEvent start:
                    if (_isHiddenToolName(start.ToolCallName) || hiddenToolCallIds.Contains(start.ToolCallId))
                    {
                        hiddenToolCallIds.Add(start.ToolCallId);
                        output = null;
                    }

                    break;

                case ToolCallArgsEvent args when hiddenToolCallIds.Contains(args.ToolCallId):
                case ToolCallEndEvent end when hiddenToolCallIds.Contains(end.ToolCallId):
                case ToolCallResultEvent result when hiddenToolCallIds.Contains(result.ToolCallId):
                    output = null;
                    break;

                case ToolCallChunkEvent chunk:
                    if (chunkLanes.IsHidden(chunk, _isHiddenToolName, hiddenToolCallIds))
                    {
                        output = null;
                    }

                    break;

                case MessagesSnapshotEvent snapshot:
                    output = FilterSnapshot(snapshot, hiddenToolCallIds);
                    break;

                case RawEvent raw:
                    if (HiddenToolCallReferenceScanner.References(raw.Event, _isHiddenToolName, !_isAllowList, hiddenToolCallIds))
                    {
                        output = null;
                    }

                    break;
            }

            if (output is null)
            {
                continue;
            }

            // A snapshot or echoed input can reveal hidden calls the raw data mentions only by ID.
            if (!rawMentionsHiddenCall
                && hiddenToolCallIds.Count > knownHiddenCalls
                && output.RawEvent is { } revisited)
            {
                rawMentionsHiddenCall = HiddenToolCallReferenceScanner.References(
                    revisited, _isHiddenToolName, !_isAllowList, hiddenToolCallIds);
            }

            if (rawMentionsHiddenCall && output.RawEvent is not null)
            {
                // Copy rather than mutate: the event may belong to the caller (a passthrough raw
                // representation, or a mapper's result).
                if (ReferenceEquals(output, evt))
                {
                    output = Clone(output);
                }

                output.RawEvent = null;
            }

            chunkLanes.Observe(output);
            yield return output;
        }
    }

    private MessagesSnapshotEvent FilterSnapshot(MessagesSnapshotEvent snapshot, HashSet<string> hiddenToolCallIds)
    {
        RegisterHiddenCalls(snapshot.Messages, hiddenToolCallIds);
        if (!ReferencesHiddenCalls(snapshot.Messages, hiddenToolCallIds))
        {
            return snapshot;
        }

        var copy = (MessagesSnapshotEvent)Clone(snapshot);
        copy.Messages = RemoveHiddenCalls(copy.Messages, hiddenToolCallIds);
        return copy;
    }

    // A producer may echo the input, including server-side history, on RUN_STARTED.
    private RunStartedEvent FilterRunStarted(RunStartedEvent started, HashSet<string> hiddenToolCallIds)
    {
        if (started.Input is not { } echoed)
        {
            return started;
        }

        RegisterHiddenCalls(echoed.Messages, hiddenToolCallIds);
        if (!ReferencesHiddenCalls(echoed.Messages, hiddenToolCallIds))
        {
            return started;
        }

        var copy = (RunStartedEvent)Clone(started);
        copy.Input!.Messages = RemoveHiddenCalls(copy.Input.Messages, hiddenToolCallIds);
        return copy;
    }

    private void RegisterHiddenCalls(IEnumerable<AGUIMessage> messages, HashSet<string> hiddenToolCallIds)
    {
        foreach (var message in messages)
        {
            if (message is AGUIAssistantMessage { ToolCalls: { } toolCalls })
            {
                foreach (var toolCall in toolCalls)
                {
                    if (_isHiddenToolName(toolCall.Function.Name))
                    {
                        hiddenToolCallIds.Add(toolCall.Id);
                    }
                }
            }
        }
    }

    private static bool ReferencesHiddenCalls(IEnumerable<AGUIMessage> messages, HashSet<string> hiddenToolCallIds) =>
        messages.Any(message => message switch
        {
            AGUIToolMessage tool => hiddenToolCallIds.Contains(tool.ToolCallId),
            AGUIAssistantMessage { ToolCalls: { } toolCalls } => toolCalls.Any(toolCall => hiddenToolCallIds.Contains(toolCall.Id)),
            _ => false,
        });

    // Mutates the messages it keeps, so only pass a copy.
    private static List<AGUIMessage> RemoveHiddenCalls(IEnumerable<AGUIMessage> copiedMessages, HashSet<string> hiddenToolCallIds)
    {
        var kept = new List<AGUIMessage>();
        foreach (var message in copiedMessages)
        {
            if (message is AGUIToolMessage tool && hiddenToolCallIds.Contains(tool.ToolCallId))
            {
                continue;
            }

            if (message is AGUIAssistantMessage { ToolCalls: { } toolCalls } assistant)
            {
                var visible = toolCalls.Where(toolCall => !hiddenToolCallIds.Contains(toolCall.Id)).ToList();
                if (visible.Count != toolCalls.Count)
                {
                    assistant.ToolCalls = visible.Count > 0 ? visible : null;
                    if (visible.Count == 0 && string.IsNullOrEmpty(assistant.Content) && assistant.EncryptedValue is null)
                    {
                        continue;
                    }
                }
            }

            kept.Add(message);
        }

        return kept;
    }

    private static BaseEvent Clone(BaseEvent evt)
    {
        var json = JsonSerializer.SerializeToElement(evt, AGUIJsonSerializerContext.Default.BaseEvent);
        return json.Deserialize(AGUIJsonSerializerContext.Default.BaseEvent)!;
    }
}
