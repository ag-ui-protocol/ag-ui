using System;
using System.Collections.Generic;
using System.Linq;
using AGUI.Abstractions;

namespace AGUI.Server;

// Decides whether a TOOL_CALL_CHUNK belongs to a hidden call. It only ever hides chunks and never
// rewrites them, so with nothing hidden the stream passes through untouched.
// - A chunk with an ID belongs to that call, and opens a stream in its lane (parent agent or
//   subagent run) if no lane holds the ID yet.
// - An ID-less chunk is a continuation, even when it repeats the tool name. A tagged continuation
//   is hidden when its subagent's lane is hidden. An untagged one is hidden while any open lane is
//   hidden, because the client may attribute it to that lane.
// Only events that reach the client close lanes (see Observe), so a hidden lane stays open here
// at least as long as on the client. Ownership of visible continuations is left to the client.
// Dropping a hidden event that would have closed a lane can change which visible stream an
// untagged continuation joins there; that misplaces visible data but reveals nothing hidden.
internal sealed class ToolCallChunkLanes
{
    private const string ParentLane = "\0parent";

    private readonly Dictionary<string, (string CallId, bool Hidden)> _lanes = new(StringComparer.Ordinal);

    // Called with each event that is actually sent, so closing follows what the client sees.
    public void Observe(BaseEvent evt)
    {
        switch (evt)
        {
            case RunStartedEvent or RunFinishedEvent or RunErrorEvent or MessagesSnapshotEvent:
                _lanes.Clear();
                break;
            case SubagentFinishedEvent { SubagentRunId: { } finished }:
                _lanes.Remove(finished);
                break;
            case SubagentErrorEvent { SubagentRunId: { } failed }:
                _lanes.Remove(failed);
                break;
            case TextMessageStartEvent e: Close(e.SubagentRunId); break;
            case TextMessageContentEvent e: Close(e.SubagentRunId); break;
            case TextMessageEndEvent e: Close(e.SubagentRunId); break;
            case ToolCallStartEvent e: Close(e.SubagentRunId); break;
            case ToolCallArgsEvent e: Close(e.SubagentRunId); break;
            case ToolCallEndEvent e: Close(e.SubagentRunId); break;
            case ToolCallResultEvent e: Close(e.SubagentRunId); break;
            case StateSnapshotEvent e: Close(e.SubagentRunId); break;
            case StateDeltaEvent e: Close(e.SubagentRunId); break;
            case CustomEvent e: Close(e.SubagentRunId); break;
            case StepStartedEvent e: Close(e.SubagentRunId); break;
            case StepFinishedEvent e: Close(e.SubagentRunId); break;
            case ReasoningStartEvent e: Close(e.SubagentRunId); break;
            case ReasoningMessageStartEvent e: Close(e.SubagentRunId); break;
            case ReasoningMessageContentEvent e: Close(e.SubagentRunId); break;
            case ReasoningMessageEndEvent e: Close(e.SubagentRunId); break;
            case ReasoningEndEvent e: Close(e.SubagentRunId); break;
        }
    }

    public bool IsHidden(ToolCallChunkEvent chunk, Func<string, bool> isHiddenToolName, HashSet<string> hiddenToolCallIds)
    {
        if (chunk.ToolCallId is { } id)
        {
            var hidden = hiddenToolCallIds.Contains(id)
                || (chunk.ToolCallName is { } name && isHiddenToolName(name));
            if (hidden)
            {
                hiddenToolCallIds.Add(id);
            }

            if (!_lanes.Values.Any(open => open.CallId == id))
            {
                _lanes[chunk.SubagentRunId ?? ParentLane] = (id, hidden);
            }

            return hidden;
        }

        if (chunk.ToolCallName is { } repeatedName && isHiddenToolName(repeatedName))
        {
            return true;
        }

        if (chunk.SubagentRunId is { } tag)
        {
            return _lanes.TryGetValue(tag, out var lane) && lane.Hidden;
        }

        return _lanes.Values.Any(open => open.Hidden);
    }

    private void Close(string? subagentRunId) => _lanes.Remove(subagentRunId ?? ParentLane);
}
