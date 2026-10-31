using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AGUI.MicrosoftAgentFramework;

/// <summary>
/// Records original approval requests and durably collects decisions before invoking a stock agent.
/// </summary>
/// <remarks>
/// Every execution of a managed session must pass through this wrapper, including native SDK executions.
/// The persistence callback must durably save the complete native session. Hosts must serialize access
/// to a session across processes. Accepted decisions are coordinator state, not native execution results.
/// </remarks>
public sealed class DurableApprovalAgent : DelegatingAIAgent
{
    private const string PendingKey = "agui.approvals.v1.pending";
    private const string BufferedKey = "agui.approvals.v1.buffered";
    private const string InitializedKey = "agui.approvals.v1.initialized";
    private const string DispatchKey = "agui.approvals.v1.dispatching";
    private const string CompletedKey = "agui.approvals.v1.completedFrontend";
    private readonly Func<AgentSession, CancellationToken, ValueTask> saveSession;
    private readonly HashSet<string> frontendTools;
    private readonly ConditionalWeakTable<AgentSession, SemaphoreSlim> gates = new();

    internal bool IsFrontendTool(string name) => this.frontendTools.Contains(name);

    internal static HashSet<string> GetCollectedFrontendCallIds(AgentSession session) => Read(session, BufferedKey)
        .SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId).ToHashSet(StringComparer.Ordinal);

    /// <summary>Creates a coordinator whose frontend tool names are configured by the trusted host.</summary>
    public DurableApprovalAgent(
        ChatClientAgent innerAgent,
        Func<AgentSession, CancellationToken, ValueTask> saveSession,
        IEnumerable<string>? frontendToolNames = null) : base(innerAgent)
    {
        ArgumentNullThrowHelper.ThrowIfNull(saveSession);
        this.saveSession = saveSession;
        this.frontendTools = new HashSet<string>(frontendToolNames ?? [], StringComparer.Ordinal);
    }

    /// <summary>Gets server-recorded requests that have not yet been dispatched as a complete batch.</summary>
    public IReadOnlyList<ToolApprovalRequestContent> GetPendingApprovals(AgentSession session)
    {
        ArgumentNullThrowHelper.ThrowIfNull(session);
        return Read(session, PendingKey).SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToArray();
    }

    /// <summary>Gets durably collected intent. These decisions have not yet been executed by the native agent.</summary>
    public IReadOnlyList<ToolApprovalResponseContent> GetAcceptedDecisions(AgentSession session)
    {
        ArgumentNullThrowHelper.ThrowIfNull(session);
        return Read(session, BufferedKey).SelectMany(m => m.Contents).OfType<ToolApprovalResponseContent>().ToArray();
    }

    /// <summary>
    /// Exports a detached version-1 checkpoint for archive/import adapters. Content uses the public
    /// Microsoft.Extensions.AI JSON representation; the export grants no authority to resume a session.
    /// </summary>
    public JsonElement ExportCheckpoint(AgentSession session)
    {
        ArgumentNullThrowHelper.ThrowIfNull(session);
        if (session.StateBag.GetValue<List<string>>(InitializedKey) is null)
        {
            throw new InvalidOperationException("This native session was not created through the durable approval coordinator.");
        }
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", 1);
            writer.WriteBoolean("dispatchUncertain", session.StateBag.GetValue<List<string>>(DispatchKey) is { Count: > 0 });
            WriteContents(writer, "pendingRequests", this.GetPendingApprovals(session).Cast<AIContent>().ToList());
            WriteContents(writer, "acceptedDecisions", this.GetAcceptedDecisions(session).Cast<AIContent>().ToList());
            WriteContents(writer, "completedFrontendRequests", Read(session, CompletedKey).SelectMany(m => m.Contents).ToList());
            writer.WritePropertyName("bufferedMessages");
            JsonSerializer.Serialize(writer, Read(session, BufferedKey), AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(List<ChatMessage>)));
            writer.WriteEndObject();
        }
        using JsonDocument document = JsonDocument.Parse(stream.ToArray());
        return document.RootElement.Clone();
    }

    private static void WriteContents(Utf8JsonWriter writer, string property, List<AIContent> contents)
    {
        writer.WritePropertyName(property);
        JsonSerializer.Serialize(writer, contents, AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(List<AIContent>)));
    }

    /// <inheritdoc />
    protected override async ValueTask<AgentSession> CreateSessionCoreAsync(CancellationToken cancellationToken = default)
    {
        AgentSession session = await base.CreateSessionCoreAsync(cancellationToken).ConfigureAwait(false);
        session.StateBag.SetValue(InitializedKey, new List<string> { "1" });
        return session;
    }

    /// <inheritdoc />
    protected override async Task<AgentResponse> RunCoreAsync(IEnumerable<ChatMessage> messages, AgentSession? session = null,
        AgentRunOptions? options = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullThrowHelper.ThrowIfNull(messages);
        session ??= await this.CreateSessionAsync(cancellationToken).ConfigureAwait(false);
        SemaphoreSlim gate = this.gates.GetValue(session, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            List<ChatMessage>? ready = await this.PrepareAsync(messages, session, cancellationToken).ConfigureAwait(false);
            if (ready is null)
            {
                return new AgentResponse([]);
            }

            AgentRunOptions? configured = this.ConfigureOptions(session, options);
            AgentResponse response = await this.InnerAgent.RunAsync(ready, session, configured, cancellationToken).ConfigureAwait(false);
            await this.RecordAsync(session, response.Messages, cancellationToken).ConfigureAwait(false);
            return response;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <inheritdoc />
    protected override async IAsyncEnumerable<AgentResponseUpdate> RunCoreStreamingAsync(IEnumerable<ChatMessage> messages,
        AgentSession? session = null, AgentRunOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullThrowHelper.ThrowIfNull(messages);
        session ??= await this.CreateSessionAsync(cancellationToken).ConfigureAwait(false);
        SemaphoreSlim gate = this.gates.GetValue(session, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            List<ChatMessage>? ready = await this.PrepareAsync(messages, session, cancellationToken).ConfigureAwait(false);
            if (ready is null)
            {
                yield break;
            }

            List<AgentResponseUpdate> updates = [];
            List<AgentResponseUpdate> deferred = [];
            await foreach (AgentResponseUpdate update in this.InnerAgent.RunStreamingAsync(ready, session,
                this.ConfigureOptions(session, options), cancellationToken).ConfigureAwait(false))
            {
                updates.Add(update);
                if (deferred.Count > 0 || update.Contents.Any(c => c is ToolApprovalRequestContent))
                {
                    deferred.Add(update);
                }
                else
                {
                    yield return update;
                }
            }

            List<ChatMessage> output = updates.Select(u => new ChatMessage(u.Role ?? ChatRole.Assistant, u.Contents)).ToList();
            await this.RecordAsync(session, output, cancellationToken).ConfigureAwait(false);
            foreach (AgentResponseUpdate update in deferred)
            {
                yield return update;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private async ValueTask<List<ChatMessage>?> PrepareAsync(IEnumerable<ChatMessage> messages, AgentSession session,
        CancellationToken cancellationToken)
    {
        if (session.StateBag.GetValue<List<string>>(InitializedKey) is null)
        {
            throw new InvalidOperationException("This native session was not created through the durable approval coordinator.");
        }
        if (session.StateBag.GetValue<List<string>>(DispatchKey) is { Count: > 0 })
        {
            throw new InvalidOperationException("The previous native dispatch did not durably finish. Reconcile its effects before continuing this session.");
        }

        List<ChatMessage> incoming = messages.ToList();
        Dictionary<string, ToolApprovalRequestContent> pending = this.GetPendingApprovals(session).ToDictionary(r => r.RequestId, StringComparer.Ordinal);
        List<ChatMessage> buffered = Read(session, BufferedKey);
        HashSet<string> accepted = buffered.SelectMany(m => m.Contents).OfType<ToolApprovalResponseContent>().Select(r => r.RequestId).ToHashSet(StringComparer.Ordinal);
        HashSet<string> completed = buffered.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.CallId).ToHashSet(StringComparer.Ordinal);
        List<ChatMessage> canonical = [];
        foreach (ChatMessage message in incoming)
        {
            List<AIContent> contents = [];
            foreach (AIContent content in message.Contents)
            {
                if (content is ToolApprovalResponseContent decision)
                {
                    if (!pending.TryGetValue(decision.RequestId, out ToolApprovalRequestContent? original) || !accepted.Add(decision.RequestId))
                    {
                        throw new InvalidOperationException("Approval ID is stale, unknown, or already answered.");
                    }
                    if (original.ToolCall is FunctionCallContent frontendCall && this.frontendTools.Contains(frontendCall.Name))
                    {
                        throw new InvalidOperationException("Frontend calls require their original tool result, not a server approval response.");
                    }
                    contents.Add(original.CreateResponse(decision.Approved));
                }
                else if (content is FunctionResultContent result)
                {
                    ToolApprovalRequestContent? original = pending.Values.SingleOrDefault(r =>
                        r.ToolCall is FunctionCallContent call && call.CallId == result.CallId && this.frontendTools.Contains(call.Name));
                    if (original is null || !completed.Add(result.CallId))
                    {
                        throw new InvalidOperationException("Tool result is duplicate or does not match a pending frontend call.");
                    }
                    contents.Add(result);
                }
                else if (content is ToolApprovalRequestContent or FunctionCallContent)
                {
                    throw new InvalidOperationException("Caller-supplied tool requests cannot establish approval authority.");
                }
                else
                {
                    contents.Add(content);
                }
            }
            ChatMessage copy = message.Clone();
            copy.Contents = contents;
            canonical.Add(copy);
        }

        if (pending.Count == 0)
        {
            session.StateBag.SetValue(DispatchKey, new List<string> { "in-flight" });
            await this.saveSession(session, cancellationToken).ConfigureAwait(false);
            return canonical;
        }

        List<ChatMessage> updated = [.. buffered, .. canonical];
        session.StateBag.SetValue(BufferedKey, updated);
        try
        {
            await this.saveSession(session, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            session.StateBag.SetValue(BufferedKey, buffered);
            throw;
        }

        bool complete = pending.Values.All(r => r.ToolCall is FunctionCallContent call && this.frontendTools.Contains(call.Name)
            ? completed.Contains(call.CallId) : accepted.Contains(r.RequestId));
        if (!complete)
        {
            return null;
        }
        // A crash after native side effects must never cause an automatic replay of the same batch.
        session.StateBag.SetValue(DispatchKey, new List<string> { "in-flight" });
        await this.saveSession(session, cancellationToken).ConfigureAwait(false);
        return updated;
    }

    private AgentRunOptions? ConfigureOptions(AgentSession session, AgentRunOptions? options)
    {
        ToolApprovalRequestContent[] frontend = this.GetPendingApprovals(session)
            .Concat(Read(session, CompletedKey).SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>()).Where(r =>
            r.ToolCall is FunctionCallContent call && this.frontendTools.Contains(call.Name)).ToArray();
        if (frontend.Length == 0 && this.frontendTools.Count == 0)
        {
            return options;
        }
        if (options is not null and not ChatClientAgentRunOptions)
        {
            throw new ArgumentException("Mixed frontend continuation requires ChatClientAgentRunOptions.", nameof(options));
        }
        ChatClientAgentRunOptions configured = options is ChatClientAgentRunOptions original ? (ChatClientAgentRunOptions)original.Clone() : new();
        Func<IChatClient, IChatClient>? prior = configured.ChatClientFactory;
        configured.ChatClientFactory = client => new CompletedFrontendResultsChatClient(
            new FrontendDeclarationChatClient(prior?.Invoke(client) ?? client, this.frontendTools), frontend);
        return configured;
    }

    private async ValueTask RecordAsync(AgentSession session, IEnumerable<ChatMessage> output, CancellationToken cancellationToken)
    {
        List<ChatMessage> completed = Read(session, CompletedKey);
        ToolApprovalRequestContent[] frontend = this.GetPendingApprovals(session).Where(r =>
            r.ToolCall is FunctionCallContent call && this.frontendTools.Contains(call.Name)).ToArray();
        if (frontend.Length > 0)
        {
            completed = [.. completed, new ChatMessage(ChatRole.Assistant, frontend.Cast<AIContent>().ToList())];
        }
        List<ToolApprovalRequestContent> requests = output.SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToList();
        if (requests.Select(r => r.RequestId).Distinct(StringComparer.Ordinal).Count() != requests.Count)
        {
            throw new InvalidOperationException("Native agent returned duplicate approval request IDs.");
        }
        session.StateBag.SetValue(PendingKey, requests.Count == 0 ? new List<ChatMessage>() : [new ChatMessage(ChatRole.Assistant, requests.Cast<AIContent>().ToList())]);
        session.StateBag.SetValue(BufferedKey, new List<ChatMessage>());
        session.StateBag.SetValue(CompletedKey, completed);
        session.StateBag.SetValue(DispatchKey, new List<string>());
        try
        {
            await this.saveSession(session, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            session.StateBag.SetValue(DispatchKey, new List<string> { "in-flight" });
            throw;
        }
    }

    private static List<ChatMessage> Read(AgentSession session, string key) => session.StateBag.GetValue<List<ChatMessage>>(key) ?? [];
}
