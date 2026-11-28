using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace AGUI.MicrosoftAgentFramework;

internal sealed class CompletedFrontendResultsChatClient(
    IChatClient innerClient,
    IReadOnlyList<ToolApprovalRequestContent> authoritativeFrontendRequests) : DelegatingChatClient(innerClient)
{
    public override Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return base.GetResponseAsync(Normalize(messages), options, cancellationToken);
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var update in base.GetStreamingResponseAsync(Normalize(messages), options, cancellationToken).ConfigureAwait(false))
        {
            yield return update;
        }
    }

    internal List<ChatMessage> Normalize(IEnumerable<ChatMessage> messages)
    {
        var input = messages.ToList();
        var originals = authoritativeFrontendRequests.ToDictionary(r => r.ToolCall.CallId, StringComparer.Ordinal);
        var completed = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        foreach (var result in input.SelectMany(m => m.Contents).OfType<FunctionResultContent>())
        {
            if (originals.ContainsKey(result.CallId) && !completed.TryAdd(result.CallId, result))
            {
                throw new InvalidOperationException($"Multiple results for frontend call '{result.CallId}'.");
            }
        }

        if (completed.Count == 0)
        {
            return input;
        }

        // Only the trusted checkpoint supplies call names and arguments. Caller-echoed calls
        // and approval envelopes are discarded for these already completed frontend calls.
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        List<ChatMessage> output = [];
        foreach (var message in input)
        {
            List<AIContent> remaining = [];
            List<AIContent> calls = [];
            List<AIContent> results = [];
            foreach (var content in message.Contents)
            {
                var callId = content switch
                {
                    ToolApprovalRequestContent request => request.ToolCall.CallId,
                    ToolApprovalResponseContent response => response.ToolCall.CallId,
                    FunctionCallContent call => call.CallId,
                    FunctionResultContent result => result.CallId,
                    _ => null,
                };
                if (callId is null || !completed.TryGetValue(callId, out var originalResult))
                {
                    remaining.Add(content);
                    continue;
                }

                if (content is ToolApprovalRequestContent checkpointRequest && checkpointRequest.RequestId != originals[callId].RequestId)
                {
                    throw new InvalidOperationException("Frontend approval request does not match its trusted checkpoint.");
                }

                if (content is ToolApprovalRequestContent && emitted.Add(callId))
                {
                    if (originals[callId].ToolCall is not FunctionCallContent original)
                    {
                        throw new InvalidOperationException("Frontend checkpoint must contain function calls.");
                    }

                    calls.Add(new FunctionCallContent(original.CallId, original.Name,
                        original.Arguments is null ? null : new Dictionary<string, object?>(original.Arguments))
                    {
                        InformationalOnly = true,
                        AdditionalProperties = original.AdditionalProperties is null ? null : new AdditionalPropertiesDictionary(original.AdditionalProperties),
                        Annotations = original.Annotations is null ? null : [.. original.Annotations],
                        RawRepresentation = original.RawRepresentation,
                    });
                    results.Add(originalResult);
                }
            }

            if (calls.Count > 0)
            {
                output.Add(new ChatMessage(ChatRole.Assistant, calls));
                output.Add(new ChatMessage(ChatRole.Tool, results));
            }

            if (remaining.Count > 0)
            {
                var copy = message.Clone();
                copy.Contents = remaining;
                output.Add(copy);
            }
        }

        if (emitted.Count != completed.Count)
        {
            throw new InvalidOperationException("Completed frontend call is missing its saved approval request.");
        }

        return output;
    }
}
