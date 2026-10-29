using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUI.MicrosoftAgentFramework;

/// <summary>Adapts delta AG-UI requests after a trusted host has loaded the native session.</summary>
public static class DurableApprovalAGUIExtensions
{
    /// <summary>
    /// Runs a delta request against the already-authorized session and emits durable waiting decisions
    /// immediately before RUN_FINISHED. Hosts must authenticate and load input.ThreadId before calling.
    /// </summary>
    public static async IAsyncEnumerable<BaseEvent> RunAGUIAsync(this DurableApprovalAgent agent,
        RunAgentInput input, AgentSession session, JsonSerializerOptions jsonSerializerOptions,
        string decisionEventName, AGUIStreamOptions? streamOptions = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullThrowHelper.ThrowIfNull(agent);
        ArgumentNullThrowHelper.ThrowIfNull(input);
        ArgumentNullThrowHelper.ThrowIfNull(session);
        ArgumentException.ThrowIfNullOrWhiteSpace(decisionEventName);
        ChatRequestContext context = Bind(input, agent, session, jsonSerializerOptions, streamOptions);
        await foreach (BaseEvent item in Updates(agent, context, session, cancellationToken)
            .AsAGUIEventStreamAsync(context, cancellationToken).ConfigureAwait(false))
        {
            if (item is RunFinishedEvent)
            {
                yield return CreateDecisionSnapshot(agent, session, decisionEventName);
            }
            yield return item;
        }
    }

    internal static ChatRequestContext Bind(RunAgentInput input, DurableApprovalAgent agent,
        AgentSession session, JsonSerializerOptions options, AGUIStreamOptions? streamOptions)
    {
        if (input.Tools?.Any(tool => !agent.IsFrontendTool(tool.Name)) is true)
        {
            throw new InvalidOperationException("Client tools must match the host's configured frontend tools.");
        }
        // Generic resume decoding needs replayed call history. This adapter instead binds exact
        // original interrupt IDs from the selected server session without adding history to native input.
        RunAgentInput withoutResume = new()
        {
            ThreadId = input.ThreadId, RunId = input.RunId, ParentRunId = input.ParentRunId,
            ProtocolVersion = input.ProtocolVersion, State = input.State, Messages = input.Messages,
            Tools = input.Tools, Context = input.Context, ForwardedProperties = input.ForwardedProperties,
        };
        ChatRequestContext context = withoutResume.ToChatRequestContext(options, streamOptions);
        context.Messages.Clear();
        context.Messages.AddRange(input.Messages.AsChatMessages());
        Dictionary<string, ToolApprovalRequestContent> pending = agent.GetPendingApprovals(session)
            .ToDictionary(r => r.RequestId, StringComparer.Ordinal);
        HashSet<string> seen = [];
        foreach (AGUIResume resume in input.Resume ?? [])
        {
            if (!seen.Add(resume.InterruptId) || !pending.TryGetValue(resume.InterruptId, out ToolApprovalRequestContent? request))
            {
                throw new InvalidOperationException("Resume ID is duplicate, stale, or belongs to another session.");
            }
            bool approved;
            if (resume.Status == ResumeStatus.Cancelled)
            {
                approved = false;
            }
            else if (resume.Status == ResumeStatus.Resolved && resume.Payload is { ValueKind: JsonValueKind.Object } payload &&
                payload.TryGetProperty("approved", out JsonElement answer) && answer.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                approved = answer.GetBoolean();
            }
            else
            {
                throw new InvalidOperationException("Approval resume requires a boolean approved value or cancelled status.");
            }
            context.Messages.Add(new ChatMessage(ChatRole.User, [request.CreateResponse(approved)]));
        }
        return context;
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> Updates(DurableApprovalAgent agent,
        ChatRequestContext context, AgentSession session, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        bool emitted = false;
        await foreach (AgentResponseUpdate update in agent.RunStreamingAsync(context.Messages, session,
            new ChatClientAgentRunOptions(context.ChatOptions), cancellationToken).ConfigureAwait(false))
        {
            emitted = true;
            yield return update.AsChatResponseUpdate();
        }
        if (!emitted)
        {
            HashSet<string> accepted = agent.GetAcceptedDecisions(session).Select(d => d.RequestId).ToHashSet(StringComparer.Ordinal);
            HashSet<string> completedFrontend = DurableApprovalAgent.GetCollectedFrontendCallIds(session);
            foreach (ToolApprovalRequestContent request in agent.GetPendingApprovals(session))
            {
                if (!accepted.Contains(request.RequestId) && !completedFrontend.Contains(request.ToolCall.CallId))
                {
                    yield return new ChatResponseUpdate(ChatRole.Assistant, [request]);
                }
            }
        }
    }

    private static CustomEvent CreateDecisionSnapshot(DurableApprovalAgent agent, AgentSession session, string name)
    {
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", 1);
            writer.WriteStartArray("decisions");
            foreach (ToolApprovalResponseContent decision in agent.GetAcceptedDecisions(session))
            {
                writer.WriteStartObject();
                writer.WriteString("requestId", decision.RequestId);
                writer.WriteString("toolCallId", decision.ToolCall.CallId);
                writer.WriteBoolean("approved", decision.Approved);
                writer.WriteString("status", "waiting");
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        using JsonDocument document = JsonDocument.Parse(stream.ToArray());
        return new CustomEvent { Name = name, Value = document.RootElement.Clone() };
    }
}
