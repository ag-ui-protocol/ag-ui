#pragma warning disable CA2227 // Collection properties should be read-only — Tools is read-write by design

using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// Extension methods for adapting <see cref="RunAgentInput"/> to the
/// Microsoft.Extensions.AI request shape.
/// </summary>
public static class RunAgentInputExtensions
{
    /// <summary>
    /// Adapts an AG-UI <see cref="RunAgentInput"/> into a <see cref="ChatRequestContext"/>
    /// containing a <see cref="ChatMessage"/> list, a <see cref="ChatOptions"/> with the
    /// originating input stashed on <see cref="ChatOptions.AdditionalProperties"/> (recoverable via
    /// <see cref="TryGetRunAgentInput"/>), the
    /// supplied <see cref="JsonSerializerOptions"/>, and (optionally) caller-provided
    /// <see cref="AGUIStreamOptions"/>.
    /// </summary>
    /// <param name="input">The AG-UI input to adapt.</param>
    /// <param name="jsonSerializerOptions">JSON serializer options used both for downstream serialization and by the stream converter. Typically resolved from the host's configured JSON options by the caller.</param>
    /// <param name="streamOptions">
    /// Optional stream-converter configuration (interrupt mapper, result mappings, etc.).
    /// Typically resolved by the caller from DI or endpoint metadata. If <see langword="null"/>,
    /// a default instance is created. The returned context owns this instance.
    /// </param>
    /// <returns>A <see cref="ChatRequestContext"/> with the adapted request, ready to be
    /// passed to <see cref="IChatClient.GetStreamingResponseAsync(IEnumerable{ChatMessage}, ChatOptions?, System.Threading.CancellationToken)"/>
    /// and then to <see cref="ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync(IAsyncEnumerable{ChatResponseUpdate}, ChatRequestContext, System.Threading.CancellationToken)"/>.</returns>
    /// <remarks>
    /// Client tools declared on <see cref="RunAgentInput.Tools"/> are wired through the
    /// approval-flow pipeline and installed on <see cref="ChatRequestContext.ChatOptions"/>.<c>Tools</c>
    /// automatically — callers do not add them manually.
    /// </remarks>
#pragma warning disable RS0027 // Preserve the existing optional-argument overload for binary compatibility.
    public static ChatRequestContext ToChatRequestContext(
        this RunAgentInput input,
        JsonSerializerOptions jsonSerializerOptions,
        AGUIStreamOptions? streamOptions = null) =>
        input.ToChatRequestContext(jsonSerializerOptions, streamOptions, serverTools: null);
#pragma warning restore RS0027

    /// <summary>Adapts a run with trusted server tool registrations, including their approval wrappers.</summary>
    /// <param name="input">The incoming run.</param>
    /// <param name="jsonSerializerOptions">Serialization options.</param>
    /// <param name="streamOptions">Stream conversion options.</param>
    /// <param name="serverTools">Trusted server tools, added to the resulting chat options. Required for ordinary server peers in message-only continuation.</param>
    /// <returns>The adapted request.</returns>
    public static ChatRequestContext ToChatRequestContext(
        this RunAgentInput input,
        JsonSerializerOptions jsonSerializerOptions,
        AGUIStreamOptions? streamOptions,
        IList<AITool>? serverTools)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(jsonSerializerOptions);

        var messages = input.Messages.AsChatMessages().ToList();
        NormalizePendingCallBatch(messages);
        var clientTools = input.Tools?.AsAITools().ToList();

        var clientToolNames = new HashSet<string>(StringComparer.Ordinal);
        if (clientTools is not null)
        {
            foreach (var tool in clientTools)
            {
                clientToolNames.Add(tool.Name);
            }
        }

        // Translate AG-UI Resume entries into MEAI content on the message list so the
        // inner pipeline (custom IChatClient, FICC, etc.) sees standard MEAI types.
        // Tool-approval-shaped resume payloads become a ToolApprovalRequestContent +
        // ToolApprovalResponseContent pair so FunctionInvokingChatClient resumes the tool
        // naturally; everything else becomes a generic InterruptResponseContent.
        //
        // The approval interrupt advertises `{"required":["approved"]}` as its response
        // schema, so a payload carrying only `approved` is a valid answer and the tool call
        // it answers is recovered from the run's messages (which a resuming run carries by
        // spec). A payload that also echoes the full `toolCall` is still accepted.
        var resumedClientResults = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        var resumedApprovalCallIds = new HashSet<string>(StringComparer.Ordinal);
        var resumeMessageStartIndex = messages.Count;
        if (input.Resume is { Count: > 0 } resumeEntries)
        {
            var originalCallsById = new Dictionary<string, FunctionCallContent>(StringComparer.Ordinal);
            foreach (var message in messages)
            {
                foreach (var content in message.Contents)
                {
                    if (content is FunctionCallContent call)
                    {
                        originalCallsById[call.CallId] = call;
                    }
                }
            }

            var pendingApprovalCalls = CollectPendingApprovalCalls(messages, clientToolNames);

            // Calls already answered by an earlier entry in this batch. A later entry for the same
            // call, whatever its shape, stays a generic interrupt response so the tool runs once.
            var claimedCallIds = new HashSet<string>(StringComparer.Ordinal);

            // Entries that name their call (an echo or a toolCallId) are resolved first, so a bare
            // entry never competes with them whatever order the client sent them in.
            var genericResponses = new List<AIContent>(resumeEntries.Count);
            var approvalRequests = new List<AIContent>(resumeEntries.Count);
            var approvalResponses = new List<AIContent>(resumeEntries.Count);
            foreach (var resume in resumeEntries.OrderBy(r => IsBareApprovalPayload(r) ? 1 : 0))
            {
                if (TryDecodeToolApprovalResume(resume, jsonSerializerOptions,
                    originalCallsById, pendingApprovalCalls, claimedCallIds,
                    out var approvalRequest, out var approvalResponse, out var result))
                {
                    if (approvalRequest!.ToolCall is not FunctionCallContent resumedCall
                        || !originalCallsById.TryGetValue(resumedCall.CallId, out var originalCall)
                        || !ToolCallsMatch(originalCall, resumedCall))
                    {
                        throw new InvalidOperationException(
                            $"Approval Resume '{resume.InterruptId}' does not match its original tool call.");
                    }

                    approvalRequest = new ToolApprovalRequestContent(
                        approvalRequest.RequestId,
                        originalCall);
                    approvalResponse = approvalRequest.CreateResponse(
                        approvalResponse!.Approved,
                        approvalResponse.Reason);
                    result = result is null
                        ? null
                        : new FunctionResultContent(originalCall.CallId, result.Result);
                    resumedApprovalCallIds.Add(originalCall.CallId);

                    approvalRequests.Add(approvalRequest!);
                    approvalResponses.Add(approvalResponse!);
                    if (result is not null
                        && approvalRequest!.ToolCall is FunctionCallContent call
                        && clientToolNames.Contains(call.Name))
                    {
                        resumedClientResults[result.CallId] = result;
                    }
                    continue;
                }

                genericResponses.Add(new InterruptResponseContent(resume.InterruptId)
                {
                    Payload = resume.Payload,
                    Metadata = resume.Metadata,
                });
            }

            if (approvalRequests.Count > 0)
            {
                messages.Add(new ChatMessage(ChatRole.Assistant, approvalRequests));
                messages.Add(new ChatMessage(ChatRole.User, approvalResponses));
            }

            if (genericResponses.Count > 0)
            {
                messages.Add(new ChatMessage(ChatRole.User, genericResponses));
            }
        }

        var chatOptions = new ChatOptions
        {
            Tools = serverTools?.ToList(),
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                [AGUIConstants.RunAgentInputKey] = input,
            },
        };

        var isContinuation = ConfigureForMixedInvocation(
            chatOptions,
            clientTools,
            clientToolNames,
            messages,
            resumedClientResults,
            resumedApprovalCallIds,
            resumeMessageStartIndex);

        return new ChatRequestContext(
            input,
            messages,
            chatOptions,
            streamOptions ?? new AGUIStreamOptions(),
            jsonSerializerOptions,
            isContinuation,
            clientToolNames);
    }

    private static void NormalizePendingCallBatch(List<ChatMessage> messages)
    {
        // Clients can interleave parallel calls with their available results:
        // assistant(C), result(C), assistant(S). FICC must see C and S as one batch.
        var start = messages.Count;
        var assistantCount = 0;
        while (start > 0)
        {
            var message = messages[start - 1];
            if (message.Contents.Count == 0)
            {
                break;
            }
            if (message.Role == ChatRole.Assistant && message.Contents.All(content => content is FunctionCallContent))
            {
                assistantCount++;
            }
            else if (message.Role != ChatRole.Tool || message.Contents.Any(content => content is not FunctionResultContent))
            {
                break;
            }
            start--;
        }

        if (assistantCount < 2)
        {
            return;
        }

        var batch = messages.Skip(start).ToList();
        var assistant = batch.First(message => message.Role == ChatRole.Assistant).Clone();
        assistant.Contents = batch.Where(message => message.Role == ChatRole.Assistant)
            .SelectMany(message => message.Contents).ToList();
        messages.RemoveRange(start, messages.Count - start);
        messages.Add(assistant);
        messages.AddRange(batch.Where(message => message.Role == ChatRole.Tool));
    }

    /// <summary>
    /// Recovers the originating AG-UI <see cref="RunAgentInput"/> that
    /// <see cref="ToChatRequestContext(RunAgentInput, JsonSerializerOptions, AGUIStreamOptions)"/> stashed on the request's
    /// <see cref="ChatOptions"/>.<see cref="ChatOptions.AdditionalProperties"/>. Delegating
    /// <see cref="IChatClient"/> implementations and agents use this to read AG-UI inputs such as
    /// <see cref="RunAgentInput.State"/> without depending on the hosting layer's internals.
    /// </summary>
    /// <param name="options">The chat options flowed to the inner client or agent.</param>
    /// <param name="input">
    /// When this method returns <see langword="true"/>, contains the recovered
    /// <see cref="RunAgentInput"/>; otherwise <see langword="null"/>.
    /// </param>
    /// <returns><see langword="true"/> if an AG-UI input was present; otherwise <see langword="false"/>.</returns>
    public static bool TryGetRunAgentInput(this ChatOptions options, [NotNullWhen(true)] out RunAgentInput? input)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (options.AdditionalProperties?.TryGetValue(AGUIConstants.RunAgentInputKey, out var value) is true
            && value is RunAgentInput runAgentInput)
        {
            input = runAgentInput;
            return true;
        }

        input = null;
        return false;
    }

    /// <summary>
    /// Deserializes the originating AG-UI client state using the supplied JSON type metadata.
    /// </summary>
    /// <typeparam name="T">The type to deserialize the state into.</typeparam>
    /// <param name="options">The chat options containing the originating AG-UI input.</param>
    /// <param name="jsonTypeInfo">The JSON type metadata to use for deserialization.</param>
    /// <param name="state">The deserialized state, or the default value of <typeparamref name="T"/> when no state was supplied.</param>
    /// <returns>
    /// <see langword="true"/> when state was supplied and deserialized; <see langword="false"/>
    /// when the originating input or its state is absent, undefined, or JSON <see langword="null"/>.
    /// </returns>
    /// <exception cref="ArgumentNullException"><paramref name="options"/> or <paramref name="jsonTypeInfo"/> is <see langword="null"/>.</exception>
    /// <exception cref="JsonException">The supplied state is incompatible with <typeparamref name="T"/>.</exception>
    /// <remarks>
    /// Client state is untrusted. The application must validate it before using it in tools or model context.
    /// This method does not persist state or modify the originating input. Deserialization uses the supplied
    /// metadata and converters; a custom converter may return <see langword="null"/> even when this method returns <see langword="true"/>.
    /// </remarks>
    public static bool TryGetRunAgentState<T>(this ChatOptions options, JsonTypeInfo<T> jsonTypeInfo, out T? state)
    {
        ArgumentNullThrowHelper.ThrowIfNull(options);
        ArgumentNullThrowHelper.ThrowIfNull(jsonTypeInfo);

        if (!options.TryGetRunAgentInput(out var input)
            || input.State is not { } element
            || element.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            state = default;
            return false;
        }

        state = element.Deserialize(jsonTypeInfo);
        return true;
    }

    /// <summary>
    /// Collects the tool calls in <paramref name="messages"/> that are still waiting on an
    /// approval answer: a call with no <see cref="FunctionResultContent"/> and no
    /// <see cref="ToolApprovalResponseContent"/> naming it. Client tools are excluded because the
    /// client owns and gates them, so the emit side never raises an approval interrupt for one.
    /// </summary>
    private static List<FunctionCallContent> CollectPendingApprovalCalls(
        List<ChatMessage> messages,
        HashSet<string> clientToolNames)
    {
        var answeredCallIds = new HashSet<string>(StringComparer.Ordinal);
        var candidates = new List<FunctionCallContent>();

        foreach (var message in messages)
        {
            foreach (var content in message.Contents)
            {
                switch (content)
                {
                    case FunctionCallContent call when !clientToolNames.Contains(call.Name):
                        candidates.Add(call);
                        break;
                    case FunctionResultContent result:
                        answeredCallIds.Add(result.CallId);
                        break;
                    case ToolApprovalResponseContent { ToolCall: FunctionCallContent answered }:
                        answeredCallIds.Add(answered.CallId);
                        break;
                    default:
                        break;
                }
            }
        }

        if (answeredCallIds.Count > 0)
        {
            candidates.RemoveAll(call => answeredCallIds.Contains(call.CallId));
        }

        return candidates;
    }

    private static bool TryDecodeToolApprovalResume(
        AGUIResume resume,
        JsonSerializerOptions jsonSerializerOptions,
        Dictionary<string, FunctionCallContent> originalCallsById,
        List<FunctionCallContent> pendingApprovalCalls,
        HashSet<string> claimedCallIds,
        out ToolApprovalRequestContent? request,
        out ToolApprovalResponseContent? response,
        out FunctionResultContent? result)
    {
        request = null;
        response = null;
        result = null;

        if (resume.Payload is not { ValueKind: JsonValueKind.Object } element)
        {
            return false;
        }

        bool approved;
        FunctionCallContent fcc;

        if (element.TryGetProperty("toolCall", out _))
        {
            AGUIToolApprovalResumePayload? payload;
            try
            {
                payload = (AGUIToolApprovalResumePayload?)element.Deserialize(
                    jsonSerializerOptions.GetTypeInfo(typeof(AGUIToolApprovalResumePayload)));
            }
            catch (JsonException)
            {
                return false;
            }

            if (payload?.ToolCall is null)
            {
                return false;
            }

            approved = payload.Approved;
            fcc = new FunctionCallContent(
                callId: payload.ToolCall.CallId ?? string.Empty,
                name: payload.ToolCall.Name ?? string.Empty,
                arguments: payload.ToolCall.Arguments);
        }
        else
        {
            // No echo. Only a payload shaped like the advertised approval schema is treated as
            // an approval answer; anything else stays a generic interrupt response.
            if (!element.TryGetProperty("approved", out var approvedElement)
                || approvedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return false;
            }

            if (ResolvePendingApprovalCall(resume, element, originalCallsById, pendingApprovalCalls)
                is not { } resolved)
            {
                return false;
            }

            approved = approvedElement.GetBoolean();
            fcc = resolved;
        }

        // The first entry resolved for a call answers it; any later entry for it approves nothing.
        if (!claimedCallIds.Add(fcc.CallId))
        {
            return false;
        }

        pendingApprovalCalls.RemoveAll(call => string.Equals(call.CallId, fcc.CallId, StringComparison.Ordinal));

        // An abandoned interrupt is never an approval, whatever the payload claims.
        var cancelled = string.Equals(resume.Status, ResumeStatus.Cancelled, StringComparison.Ordinal);

        request = new ToolApprovalRequestContent(resume.InterruptId, fcc);
        response = new ToolApprovalResponseContent(resume.InterruptId, approved && !cancelled, fcc);
        result = new FunctionResultContent(fcc.CallId, element.TryGetProperty("result", out var resultElement) && resultElement.ValueKind != JsonValueKind.Null ? resultElement.Clone() : null);
        return true;
    }

    private static bool IsBareApprovalPayload(AGUIResume resume) =>
        resume.Payload is { ValueKind: JsonValueKind.Object } element
        && !element.TryGetProperty("toolCall", out _)
        && !element.TryGetProperty("toolCallId", out _);

    /// <summary>
    /// Recovers the tool call a <c>toolCall</c>-less approval resume answers from the run's
    /// messages. The interrupt id is the approval request id FunctionInvokingChatClient minted for
    /// the call (see <see cref="FiccApprovalRequestIdFor"/>), so it alone names the call; a
    /// <c>toolCallId</c> in the payload, when present, must agree with it.
    /// </summary>
    /// <returns>
    /// The recovered call, or <see langword="null"/> when the interrupt is not an approval
    /// interrupt or its call is already answered (the entry then stays a generic interrupt response).
    /// </returns>
    /// <exception cref="InvalidOperationException">
    /// The entry's <c>toolCallId</c> names a different call than its approval interrupt id, or the
    /// run's messages do not carry the call.
    /// </exception>
    private static FunctionCallContent? ResolvePendingApprovalCall(
        AGUIResume resume,
        JsonElement element,
        Dictionary<string, FunctionCallContent> originalCallsById,
        List<FunctionCallContent> pendingApprovalCalls)
    {
        // An interrupt id that is not an approval id (another kind of interrupt) approves nothing,
        // whatever its payload carries.
        var approvalIdPrefix = FiccApprovalRequestIdFor(string.Empty);
        if (string.IsNullOrEmpty(resume.InterruptId)
            || !resume.InterruptId.StartsWith(approvalIdPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        var interruptCallId = resume.InterruptId[approvalIdPrefix.Length..];

        if (element.TryGetProperty("toolCallId", out var toolCallIdElement)
            && toolCallIdElement.ValueKind is JsonValueKind.String
            && toolCallIdElement.GetString() is { Length: > 0 } toolCallId
            && !string.Equals(toolCallId, interruptCallId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Resume entry '{resume.InterruptId}' is the approval for tool call '{interruptCallId}', but its payload names tool call '{toolCallId}'.");
        }

        foreach (var pending in pendingApprovalCalls)
        {
            if (string.Equals(pending.CallId, interruptCallId, StringComparison.Ordinal))
            {
                return pending;
            }
        }

        // A call already answered (resolved elsewhere, or a replayed resume) is not approved a
        // second time, and a call the messages do not carry at all is rejected.
        if (originalCallsById.ContainsKey(interruptCallId))
        {
            return null;
        }

        throw new InvalidOperationException(
            $"Resume entry '{resume.InterruptId}' answers tool call '{interruptCallId}', which the run's messages do not carry.");
    }

    // FunctionInvokingChatClient mints the approval request id for a call in its private
    // ComposeApprovalRequestId, and the server emits that request id as the interrupt id, so a
    // bare resume entry is matched back to its call through this same id. Kept in one place
    // because the format is FICC's, not ours.
    private static string FiccApprovalRequestIdFor(string callId) => "ficc_" + callId;

    private static bool ToolCallsMatch(
        FunctionCallContent originalCall,
        FunctionCallContent resumedCall)
    {
        if (!string.Equals(originalCall.Name, resumedCall.Name, StringComparison.Ordinal))
        {
            return false;
        }

        var typeInfo = AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!;
        var originalArguments = JsonSerializer.SerializeToElement(originalCall.Arguments, typeInfo);
        var resumedArguments = JsonSerializer.SerializeToElement(resumedCall.Arguments, typeInfo);
        return JsonElement.DeepEquals(originalArguments, resumedArguments);
    }

    /// <summary>
    /// Configures <paramref name="chatOptions"/> for mixed server/client tool invocation.
    /// On the first turn, wraps client tools in <see cref="ApprovalRequiredAIFunction"/> so FICC
    /// terminates with approval requests for all tools. On continuation (client tool results
    /// present in messages), creates proxy functions for client tools and injects approval
    /// responses so FICC executes all pending tool calls.
    /// </summary>
    /// <returns><see langword="true"/> if this is a continuation turn; <see langword="false"/> otherwise (either no client tools, or first turn).</returns>
    private static bool ConfigureForMixedInvocation(
        ChatOptions chatOptions,
        IList<AITool>? clientTools,
        HashSet<string> clientToolNames,
        List<ChatMessage> chatMessages,
        Dictionary<string, FunctionResultContent> resumedClientResults,
        HashSet<string> resumedApprovalCallIds,
        int resumeMessageStartIndex)
    {
        if (resumedApprovalCallIds.Count > 0)
        {
            _ = TryGetClientToolResults(
                chatMessages,
                clientToolNames,
                out var messageClientResults,
                out var resumedAssistantCallIndex,
                out _);
            foreach (var result in messageClientResults)
            {
                resumedClientResults[result.Key] = result.Value;
            }
            resumedAssistantCallIndex = resumedAssistantCallIndex >= 0
                ? resumedAssistantCallIndex
                : FindLatestAssistantFunctionCallIndex(chatMessages);
            if (resumedAssistantCallIndex < 0
                || !IsResumeForLatestCallBatch(
                    chatMessages,
                    resumedAssistantCallIndex,
                    resumeMessageStartIndex,
                    resumedApprovalCallIds))
            {
                throw new InvalidOperationException(
                    "Approval Resume entries do not match the complete latest unresolved tool-call batch.");
            }

            ProcessContinuation(
                chatOptions,
                clientTools ?? [],
                chatMessages,
                resumedClientResults,
                resumedAssistantCallIndex);
            return true;
        }

        if (clientTools is not { Count: > 0 })
        {
            return false;
        }

        if (TryGetClientToolResults(
            chatMessages,
            clientToolNames,
            out var clientCallResults,
            out var assistantCallIndex,
            out var completedClientBatch))
        {
            var resolvedCallIds = chatMessages.Skip(assistantCallIndex + 1)
                .SelectMany(message => message.Contents).OfType<FunctionResultContent>()
                .Select(result => result.CallId).ToHashSet(StringComparer.Ordinal);
            foreach (var call in chatMessages[assistantCallIndex].Contents.OfType<FunctionCallContent>())
            {
                if (resolvedCallIds.Contains(call.CallId))
                {
                    continue;
                }

                // Wire history cannot establish whether a server tool requires approval.
                // Only the application's trusted registrations can authorize the legacy path.
                var matches = chatOptions.Tools?.Where(tool => tool.Name == call.Name).Take(2).ToList();
                if (matches is { Count: > 1 })
                {
                    throw new InvalidOperationException(
                        $"Tool call '{call.CallId}' has ambiguous server tool registrations for '{call.Name}'.");
                }
                var tool = matches?.SingleOrDefault();
                // Match FICC's service lookup so decorators cannot hide approval requirements.
                if (tool is not AIFunction || tool.GetService<ApprovalRequiredAIFunction>() is not null)
                {
                    throw new InvalidOperationException(
                        $"Tool call '{call.CallId}' requires an explicit Resume decision or a trusted ordinary server tool registration.");
                }
            }

            ProcessContinuation(
                chatOptions,
                clientTools,
                chatMessages,
                clientCallResults,
                assistantCallIndex);
            return true;
        }
        if (completedClientBatch)
        {
            AddClientToolProxies(chatOptions, clientTools, clientCallResults);
            return true;
        }

        // First turn: wrap client tools in ApprovalRequiredAIFunction.
        // When FICC sees any ApprovalRequired tool called, it converts ALL FCCs in the
        // response to ToolApprovalRequestContent and terminates. The stream converter
        // unwraps them back to plain TOOL_CALL events.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            if (tool is AIFunctionDeclaration declaration)
            {
                chatOptions.Tools.Add(
                    new ApprovalRequiredAIFunction(new ClientToolAIFunction(declaration)));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }

        return false;
    }

    private static bool IsResumeForLatestCallBatch(
        List<ChatMessage> messages,
        int assistantCallIndex,
        int resumeMessageStartIndex,
        ICollection<string> resumedCallIds)
    {
        var batchCallIds = messages[assistantCallIndex].Contents
            .OfType<FunctionCallContent>()
            .Select(call => call.CallId)
            .ToHashSet(StringComparer.Ordinal);
        if (!resumedCallIds.All(batchCallIds.Contains))
        {
            return false;
        }

        var persistedResultCallIds = messages
            .Skip(assistantCallIndex + 1)
            .Take(resumeMessageStartIndex - assistantCallIndex - 1)
            .SelectMany(message => message.Contents)
            .OfType<FunctionResultContent>()
            .Select(result => result.CallId)
            .ToHashSet(StringComparer.Ordinal);
        if (persistedResultCallIds.Any(resumedCallIds.Contains)
            || !batchCallIds.All(id => persistedResultCallIds.Contains(id) || resumedCallIds.Contains(id)))
        {
            return false;
        }

        for (var i = assistantCallIndex + 1; i < resumeMessageStartIndex; i++)
        {
            if (messages[i].Contents.Any(content => content is not FunctionResultContent))
            {
                return false;
            }
        }

        return true;
    }

    private static int FindLatestAssistantFunctionCallIndex(List<ChatMessage> messages)
    {
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            if (messages[i].Role == ChatRole.Assistant
                && messages[i].Contents.Any(content => content is FunctionCallContent))
            {
                return i;
            }
        }

        return -1;
    }

    private static bool TryGetClientToolResults(
        List<ChatMessage> messages,
        HashSet<string> clientToolNames,
        out Dictionary<string, FunctionResultContent> clientCallResults,
        out int assistantCallIndex,
        out bool completedBatch)
    {
        clientCallResults = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        assistantCallIndex = -1;
        completedBatch = false;
        var clientCallIds = new HashSet<string>(StringComparer.Ordinal);
        var batchCallIds = new HashSet<string>(StringComparer.Ordinal);
        var resultCallIds = new HashSet<string>(StringComparer.Ordinal);

        for (var i = messages.Count - 1; i >= 0; i--)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionCallContent fcc && clientToolNames.Contains(fcc.Name))
                {
                    clientCallIds.Add(fcc.CallId);
                    assistantCallIndex = i;
                }
                if (content is FunctionCallContent batchCall)
                {
                    batchCallIds.Add(batchCall.CallId);
                }
            }

            if (assistantCallIndex >= 0)
            {
                break;
            }
        }

        if (assistantCallIndex < 0)
        {
            return false;
        }

        // A continuation ends with results and approval responses for the latest client-tool
        // batch. Later ordinary content means that batch belongs to completed history.
        for (var i = assistantCallIndex + 1; i < messages.Count; i++)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionResultContent frc && clientCallIds.Contains(frc.CallId))
                {
                    clientCallResults[frc.CallId] = frc;
                }
                if (content is FunctionResultContent result)
                {
                    resultCallIds.Add(result.CallId);
                }
                else if (content is not ToolApprovalRequestContent
                    && content is not ToolApprovalResponseContent)
                {
                    clientCallResults.Clear();
                    assistantCallIndex = -1;
                    return false;
                }
            }
        }

        if (batchCallIds.Count > 0 && batchCallIds.All(resultCallIds.Contains))
        {
            completedBatch = true;
            return false;
        }

        return clientCallResults.Count > 0;
    }

    private static void ProcessContinuation(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        List<ChatMessage> chatMessages,
        Dictionary<string, FunctionResultContent> clientCallResults,
        int assistantCallIndex)
    {
        var assistantMessage = chatMessages[assistantCallIndex];
        var persistedServerResultIds = chatMessages.Skip(assistantCallIndex + 1)
            .SelectMany(message => message.Contents)
            .OfType<FunctionResultContent>()
            .Select(result => result.CallId)
            .Where(id => !clientCallResults.ContainsKey(id))
            .ToHashSet(StringComparer.Ordinal);
        var existingRequests = new List<ToolApprovalRequestContent>();
        var existingResponses = new Dictionary<string, ToolApprovalResponseContent>(StringComparer.Ordinal);
        RemoveApprovalContent(chatMessages, existingRequests, existingResponses);
        RemoveClientResults(chatMessages, clientCallResults.Keys);
        assistantCallIndex = chatMessages.IndexOf(assistantMessage);
        if (assistantCallIndex < 0)
        {
            throw new InvalidOperationException("The mixed tool-call message was removed while rebuilding its approval batch.");
        }

        var existingRequestsByCallId = existingRequests
            .Where(request => request.ToolCall is FunctionCallContent)
            .ToDictionary(request => request.ToolCall.CallId, StringComparer.Ordinal);
        var mergedCallIds = new HashSet<string>(StringComparer.Ordinal);
        var approvalResponses = new List<AIContent>();
        var approvalRequests = new List<AIContent>(assistantMessage.Contents.Count + existingRequests.Count);

        foreach (var content in assistantMessage.Contents)
        {
            if (content is not FunctionCallContent call)
            {
                approvalRequests.Add(content);
                continue;
            }
            if (persistedServerResultIds.Contains(call.CallId))
            {
                continue;
            }

            if (existingRequestsByCallId.TryGetValue(call.CallId, out var existingRequest))
            {
                approvalRequests.Add(existingRequest);
                mergedCallIds.Add(call.CallId);
                if (existingResponses.TryGetValue(existingRequest.RequestId, out var existingResponse))
                {
                    approvalResponses.Add(existingResponse);
                }
                continue;
            }

            var request = new ToolApprovalRequestContent($"approval_{call.CallId}", call)
            {
#pragma warning disable MEAI001
                RequiresConfirmation = false,
#pragma warning restore MEAI001
            };
            approvalRequests.Add(request);
            approvalResponses.Add(request.CreateResponse(approved: true));
        }

        foreach (var request in existingRequests)
        {
            if (mergedCallIds.Contains(request.ToolCall.CallId))
            {
                continue;
            }

            approvalRequests.Add(request);
            if (existingResponses.TryGetValue(request.RequestId, out var response))
            {
                approvalResponses.Add(response);
            }
        }

        // FICC replaces the approval message with its resumed calls. Move already-completed
        // calls and results into a preceding, complete exchange so that replacement cannot
        // discard them or execute them again.
        var completedCalls = assistantMessage.Contents.OfType<FunctionCallContent>()
            .Where(call => persistedServerResultIds.Contains(call.CallId)).Cast<AIContent>().ToList();
        if (completedCalls.Count > 0)
        {
            var completedResults = chatMessages.Skip(assistantCallIndex + 1)
                .SelectMany(message => message.Contents).OfType<FunctionResultContent>()
                .Where(result => persistedServerResultIds.Contains(result.CallId)).Cast<AIContent>().ToList();
            RemoveClientResults(chatMessages, persistedServerResultIds);
            var completedMessage = assistantMessage.Clone();
            completedMessage.Contents = completedCalls;
            chatMessages.Insert(assistantCallIndex, completedMessage);
            chatMessages.Insert(assistantCallIndex + 1, new ChatMessage(ChatRole.Tool, completedResults));
            assistantCallIndex += 2;
        }

        var replacement = assistantMessage.Clone();
        replacement.Contents = approvalRequests;
        chatMessages[assistantCallIndex] = replacement;
        chatMessages.Insert(assistantCallIndex + 1, new ChatMessage(ChatRole.User, approvalResponses));

        // Keep the result proxy approval-wrapped. It resolves the original approved call from the
        // exact call id, while any new model-issued call stops for fresh client execution.
        AddClientToolProxies(chatOptions, clientTools, clientCallResults);
    }

    private static void AddClientToolProxies(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        IReadOnlyDictionary<string, FunctionResultContent> clientCallResults)
    {
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            if (tool is AIFunctionDeclaration declaration)
            {
                chatOptions.Tools.Add(
                    new ApprovalRequiredAIFunction(
                        new ClientToolAIFunction(declaration, clientCallResults)));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }
    }

    private static void RemoveApprovalContent(
        List<ChatMessage> chatMessages,
        List<ToolApprovalRequestContent> approvalRequests,
        Dictionary<string, ToolApprovalResponseContent> approvalResponses)
    {
        for (var i = 0; i < chatMessages.Count;)
        {
            var message = chatMessages[i];
            var retainedContents = new List<AIContent>(message.Contents.Count);

            foreach (var content in message.Contents)
            {
                if (content is ToolApprovalRequestContent request)
                {
                    approvalRequests.Add(request);
                }
                else if (content is ToolApprovalResponseContent response)
                {
                    approvalResponses[response.RequestId] = response;
                }
                else
                {
                    retainedContents.Add(content);
                }
            }

            if (retainedContents.Count == message.Contents.Count)
            {
                i++;
                continue;
            }

            if (retainedContents.Count == 0)
            {
                chatMessages.RemoveAt(i);
            }
            else
            {
                var replacement = message.Clone();
                replacement.Contents = retainedContents;
                chatMessages[i] = replacement;
                i++;
            }
        }
    }

    private static void RemoveClientResults(
        List<ChatMessage> chatMessages,
        ICollection<string> clientResultCallIds)
    {
        for (var i = chatMessages.Count - 1; i >= 0; i--)
        {
            var message = chatMessages[i];
            var retainedContents = message.Contents
                .Where(content => content is not FunctionResultContent result
                    || !clientResultCallIds.Contains(result.CallId))
                .ToList();

            if (retainedContents.Count == message.Contents.Count)
            {
                continue;
            }

            if (retainedContents.Count == 0)
            {
                chatMessages.RemoveAt(i);
            }
            else
            {
                var replacement = message.Clone();
                replacement.Contents = retainedContents;
                chatMessages[i] = replacement;
            }
        }
    }
}
